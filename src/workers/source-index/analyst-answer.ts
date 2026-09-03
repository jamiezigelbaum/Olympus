// Analyst-backed source answer handler (Lane B of the execution plan).
//
// Durable SourceIndexAnswerHandler that routes `source_answer` through the
// frozen pipeline contracts:
//
//   routeSourceIndexSearch -> buildEvidencePack -> Analyst -> evaluateReleaseGate
//
// This file is SOURCE-AGNOSTIC: it never names a corpus, source, or question
// shape. Per-source wiring (which adapters/providers exist) is injected via the
// `lanes` factory; per-question reasoning lives in the Analyst's one generic
// prompt. The pre-contracts template path in answer.ts has been deleted; this
// handler is the durable source_answer path.
//
// Trust posture (frontier-max, owner 2026-06-12):
// - localOnly is derived from the pack (any secure_local candidate).
// - secure_local claims flow to Castor as BOUNDED DERIVATIVES by default
//   (values/summaries through the analyst answer — never raw packets), with
//   the full opsec audit recorded. S5 secrets remain denied at the gate.
//   Strict mode (secureDerivativeDefault: 'approval', env
//   OLYMPUS_SECURE_DERIVATIVE_DEFAULT=approval) restores the old
//   needs_approval/s4_release behavior for unreleased secure facts.
// - An Analyst escalation proposal never releases source content. If the local
//   analyst merely reports insufficient grounded evidence, Castor receives an
//   honest extraction/coverage gap. Configured source lanes may also attempt
//   one local self-heal pass before analysis, then report repaired/in-progress
//   status in audit without weakening release gates.
// - The Castor-visible result carries the gated answer, citation locators, and
//   audits — never raw chunks, packets, or pack internals.

import type { Analyst, AnalystCitation, AnalystOptions, AnalystResult, EvidencePack } from '../../core/contracts.ts';
import { noEvidenceAnalystResult, runWithAnalystAbortSignal } from '../../core/analyst.ts';
import {
  buildEvidencePackDetailed,
  hasTemporalIntent,
  type EvidencePackBuildDetail,
  type LocalContentProviderMap,
  type SelectedEvidenceItem,
} from '../../core/evidence-pack.ts';
import {
  answerForReleaseDecision,
  buildOpsecReleaseAudit,
  createStructuredEvidenceFact,
  evaluateReleaseGate,
  type OpsecReleaseAudit,
  type ReleaseDecision,
  type StructuredEvidenceFact,
} from '../../core/opsec.ts';
import { canonicalSourceCorpusId } from '../../core/source-corpus-registry.ts';
import type { SourceIndexCorpusRegistry } from '../../core/source-index/corpus.ts';
import type {
  SourceIndexRouterAdapterMap,
  SourceIndexSkippedCorpus,
} from '../../core/source-index/router.ts';
import { mergeRetrievalDegradations } from '../../core/source-index/retrieval.ts';
import {
  assertEvidencePackModelEligible,
} from '../../core/source-model-policy.ts';
import {
  assertSecureAnalystPoolModelIdAllowed,
  type SovereigntyResolvedProfile,
} from '../../core/sovereignty.ts';
import {
  buildSourceSensitivity,
  type RetrievalDegradation,
  type SourceIndexProvenance,
  type SourceItemIdentity,
  type SourceTrustDomain,
} from '../../core/source-index/types.ts';
import { OperationError } from '../../core/operation-error.ts';
import type {
  AnalystBackend,
  SourceAnswerAnalystProvider,
  SourceIndexAnalystFallback,
  SourceIndexAnswerSelfHealAudit,
  SourceIndexAnswerEvidence,
  SourceIndexAnswerHandler,
  SourceIndexAnswerRequest,
  SourceIndexAnswerResult,
  SourceIndexAnswerCitationSpan,
  SourceIndexAnswerRetrievalDegradation,
} from './answer-types.ts';
import {
  observeSourceAnswerAnalystLeg,
  observeSourceAnswerRetrievalAttempt,
  recordSourceAnswerPhaseTimings,
  recordSourceAnswerReleaseDecision,
  recordSourceAnswerResidualAnalystOrphan,
  recordSourceAnswerRoute,
  recordSourceAnswerSkippedAnalystLeg,
  sourceAnswerTraceErrorClass,
} from './answer-latency-trace.ts';
import {
  DEFAULT_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS,
  SecureAnalystPoolState,
  deriveSecureAnalystPoolLegBudgets,
  type SecureAnalystPoolSelection,
  type SecureAnalystPoolStateOptions,
} from './analyst-pool.ts';

export interface AnalystAnswerLanes {
  registry: SourceIndexCorpusRegistry;
  adapters: SourceIndexRouterAdapterMap;
  contentProviders: LocalContentProviderMap;
}

export interface AnalystSourceIndexAnswerHandlerOptions {
  // The local analyst (Argus on Delphi/local models).
  analyst: Analyst;
  // Optional frontier analyst (createAnalyst-wrapped cloud model).
  cloudAnalyst?: Analyst;
  // Optional per-request Venice factory. Provider eligibility is governed by
  // docs/CONTRACTS.md#venice-s4-policy-normative.
  veniceAnalyst?: (request: SourceIndexAnswerRequest) => Analyst | undefined;
  // Per-request lane construction: adapters/providers can depend on request
  // account / approved_scope_key, exactly like the previous handler's adapters.
  lanes: (request: SourceIndexAnswerRequest) => AnalystAnswerLanes;
  // Optional multi-query retrieval expansion (core/query-planner.ts), passed
  // through to the EvidencePack builder. Absent = single literal query.
  queryPlanner?: (question: string) => Promise<readonly string[]>;
  defaultMaxResults?: number;
  maxCharsPerCandidate?: number;
  // Per-lane retrieval deadline for the fan-out. Its own quantity, like the two
  // analyst bounds below: it governs how long ONE corpus may take to answer,
  // not how long the whole answer may take. Absent, the router uses its
  // env-configured default (see DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS for why
  // that default is the number it is).
  laneTimeoutMs?: number;
  // 'allow' (default): secure facts release as bounded derivatives without
  // per-question approval (frontier-max posture). 'approval': legacy strict
  // gating (needs_approval/s4_release for unreleased secure facts).
  secureDerivativeDefault?: 'allow' | 'approval';
  // Bound optional trusted/private analyst lanes (for example Venice) so they
  // cannot consume the whole OpenClaw tool watchdog before local Argus fallback.
  // NOTE: this is the trusted/encrypted-cloud bound only. It is deliberately
  // decoupled from the tool-level watchdog budget (request.timeout_ms): the
  // watchdog budget and the analyst budget are different quantities, and the
  // watchdog budget must never inflate this bound.
  trustedAnalystTimeoutMs?: number;
  // Bound the LOCAL analyst (Argus on Delphi) too, but generously: slow useful
  // local work is product posture, so this is a safety ceiling (default
  // DEFAULT_LOCAL_ANALYST_TIMEOUT_MS), NOT the ~20s trusted-cloud bound. It is
  // its own quantity, independent of both the watchdog budget and the trusted
  // bound. A hung local model surfaces an honest timeout instead of silently
  // riding the watchdog to its full length.
  localAnalystTimeoutMs?: number;
  // Bound for an ordinary (standard_cloud) analyst leg. Its own quantity again:
  // shorter than the local ceiling because a cloud leg that is not answering is
  // a leg to leave for the next route step, and every cloud transport already
  // self-bounds around this value — this is the bound the HANDLER can enforce,
  // and the one the trace reports.
  cloudAnalystTimeoutMs?: number;
  selfHeal?: (input: {
    request: SourceIndexAnswerRequest;
    detail: EvidencePackBuildDetail;
    maxBudgetMs: number;
  }) => Promise<SourceAnswerSelfHealResult>;
  selfHealEnabled?: boolean;
  selfHealMaxMs?: number;
  sovereigntyAnalystRoute?: (input: {
    pack: EvidencePack;
    localOnly: boolean;
    requestedProvider: SourceAnswerAnalystProvider;
  }) => SovereigntyAnalystRouteStep[] | SovereigntyAnalystRoutePlan;
  secureAnalystPool?: SecureAnalystPoolStateOptions & {
    sloMs?: number;
    reserveMs?: number;
    lastLegTimeoutMs?: number;
  };
}

export interface SourceAnswerSelfHealResult {
  audit: SourceIndexAnswerSelfHealAudit;
  healed: boolean;
}

const DEFAULT_MAX_RESULTS = 3;
// Candidate floor for temporal questions - see maxResults derivation below.
const TEMPORAL_INTENT_MIN_RESULTS = 8;
const DEFAULT_MAX_CHARS_PER_CANDIDATE = 3_000;
const DEFAULT_TRUSTED_ANALYST_TIMEOUT_MS = 20_000;
// Generous local-analyst ceiling. Decoupled from the OpenClaw tool watchdog
// (which the skill passes as request.timeout_ms, e.g. 600s): local reasoning
// gets its own honest budget so a wedged local model fails cleanly instead of
// masquerading as a watchdog kill. Slow-but-useful local work stays allowed.
const DEFAULT_LOCAL_ANALYST_TIMEOUT_MS = 240_000;
// Matches what every cloud transport already enforces for itself, so making it
// the handler's bound changes no timing — it makes the bound interruptible,
// abort-aware, and honest in the trace.
const DEFAULT_CLOUD_ANALYST_TIMEOUT_MS = 120_000;
const DEFAULT_SELF_HEAL_MAX_MS = 20_000;

export function createAnalystSourceIndexAnswerHandler(
  options: AnalystSourceIndexAnswerHandlerOptions,
): SourceIndexAnswerHandler {
  const secureAnalystPoolState = new SecureAnalystPoolState(options.secureAnalystPool);
  return {
    async answer(request: SourceIndexAnswerRequest): Promise<SourceIndexAnswerResult> {
      const startedAt = Date.now();
      const question = request.question?.trim();
      if (!question) {
        throw new Error('source_answer requires a non-empty question.');
      }

      const includeInternal = request.include_internal !== false;
      const releaseSecureContent = request.include_secure_local_content === true
        || (options.secureDerivativeDefault ?? 'allow') === 'allow';

      const laneSetupStartedAt = Date.now();
      // Hybrid is the shared product default: an adapter with approved current
      // embeddings runs semantic + keyword retrieval; an adapter without them
      // serves keyword and records why. Callers can still pin either mode.
      // This replaces the old question-shape retry, which made recall depend on
      // a regex and paid for a second full fan-out only after keyword failed.
      const retrievalRequest = request.retrieval_mode === undefined
        ? { ...request, retrieval_mode: 'hybrid' as const }
        : request;
      const lanes = options.lanes(retrievalRequest);
      const laneSetupMs = Date.now() - laneSetupStartedAt;
      const includeSecureLocal = request.include_secure_local
        ?? requestExplicitlyTargetsSecureLocal(request, lanes.registry);

      const allowedTrustDomains: SourceTrustDomain[] = ['public_safe'];
      if (includeInternal) allowedTrustDomains.push('internal');
      if (includeSecureLocal) allowedTrustDomains.push('secure_local');
      const requestedAnalystProviderForGate =
        request.analyst_provider ?? (request.analyst_model?.trim() ? 'venice' : 'default');
      const requestedCorpusIds = sourceAnswerCorpusIds(request);
      const bulkGateStartedAt = Date.now();
      const bulkSecureLocalScope = secureLocalApprovalScopeForBulkRequest(
        request,
        includeSecureLocal,
        lanes.registry,
      );
      const bulkGateMs = Date.now() - bulkGateStartedAt;
      if (bulkSecureLocalScope.requiresApproval) {
        const decision: ReleaseDecision = {
          decision: 'needs_approval',
          reasons: ['bulk_secure_local_release_requires_approval'],
          requiredApproval: 's4_release',
        };
        const totalLatencyMs = Date.now() - startedAt;
        const phaseTimings = {
          lane_setup_ms: laneSetupMs,
          bulk_gate_ms: bulkGateMs,
          total_ms: totalLatencyMs,
        };
        recordSourceAnswerPhaseTimings(phaseTimings);
        recordSourceAnswerReleaseDecision(decision.decision);
        return {
          answer: answerForReleaseDecision(decision),
          evidence: [],
          audit: {
            searched_corpora: bulkSecureLocalScope.corpusIds,
            skipped_corpora: [],
            lane_audits: [],
            answer_synthesis: {
              private_context_used: true,
              secure_local_items_consulted: 0,
              internal_content_used: false,
              internal_items_consulted: 0,
              internal_content_failures: 0,
              analyst_backend: 'local',
              ...(requestedAnalystProviderForGate !== 'default'
                ? { requested_analyst_provider: requestedAnalystProviderForGate }
                : {}),
              ...(request.analyst_model?.trim()
                ? { requested_analyst_model: request.analyst_model.trim() }
                : {}),
              raw_source_exposed: false,
            },
            latency_ms: totalLatencyMs,
            phase_timings: phaseTimings,
            raw_source_exposed: false,
          },
          policy: {
            raw_source_exposed: false,
            source_packets_exposed: false,
            internal_content_exposed: false,
            secure_local_content_exposed: false,
            castor_safe_bridge: true,
          },
          opsec: buildOpsecReleaseAudit([], decision),
        };
      }
      const maxCharsPerCandidate =
        options.maxCharsPerCandidate ?? DEFAULT_MAX_CHARS_PER_CANDIDATE;
      // Temporal questions ("did I just get...", "what arrived today") need a
      // deeper candidate cut than the relevance default: the newest matching
      // item can sit a few ranks down minutes later, and a 3-candidate pack
      // silently drops it before temporal ordering runs (2026-07-05).
      // Explicit max_results from the caller is always respected.
      const configuredMaxResults = options.defaultMaxResults ?? DEFAULT_MAX_RESULTS;
      const maxResults = request.max_results
        ?? (hasTemporalIntent(`${question} ${request.query ?? ''}`)
          ? Math.max(configuredMaxResults, TEMPORAL_INTENT_MIN_RESULTS)
          : configuredMaxResults);
      const evidencePackStartedAt = Date.now();
      const buildDetail = (
        activeLanes: AnalystAnswerLanes,
        attempt: 'keyword' | 'hybrid' | 'selected' | 'self_heal_rebuild',
      ) => observeSourceAnswerRetrievalAttempt(attempt, () => buildEvidencePackDetailed({
          question,
          ...(request.query?.trim() ? { searchQuery: request.query.trim() } : {}),
          ...(request.selected_items?.length ? { selectedItems: selectedEvidenceItemsFromRequest(request) } : {}),
          ...(options.queryPlanner ? { queryPlanner: options.queryPlanner } : {}),
          maxResults,
          ...(requestedCorpusIds ? { corpusIds: requestedCorpusIds } : {}),
          searchContext: {
            allowedTrustDomains,
            allowCloudQueries: includeInternal,
            ...(requestedCorpusIds ? { allowedCorpusIds: requestedCorpusIds } : {}),
          },
          registry: activeLanes.registry,
          adapters: activeLanes.adapters,
          contentProviders: activeLanes.contentProviders,
          maxCharsPerCandidate,
          ...(options.laneTimeoutMs !== undefined ? { laneTimeoutMs: options.laneTimeoutMs } : {}),
        }));
      const initialAttempt = request.selected_items?.length
        ? 'selected'
        : retrievalRequest.retrieval_mode ?? 'hybrid';
      let detail = await buildDetail(lanes, initialAttempt);
      let evidencePackMs = Date.now() - evidencePackStartedAt;
      let selfHealAudit: SourceIndexAnswerSelfHealAudit | undefined;
      let selfHealMs: number | undefined;
      if ((options.selfHealEnabled ?? true) && options.selfHeal) {
        const selfHealStartedAt = Date.now();
        const selfHeal = await options.selfHeal({
          request,
          detail,
          maxBudgetMs: options.selfHealMaxMs ?? DEFAULT_SELF_HEAL_MAX_MS,
        });
        selfHealMs = Date.now() - selfHealStartedAt;
        selfHealAudit = selfHeal.audit;
        if (selfHeal.healed) {
          const rebuildStartedAt = Date.now();
          const preRebuild = detail;
          const rebuilt = await buildDetail(lanes, 'self_heal_rebuild');
          // pack and candidate ids come from the rebuild alone, so the analyst,
          // facts, and citations all describe the same evidence. The audit is
          // cumulative: the retry that selected this lane set, and every lane it
          // lost on the way, are still what the caller has to be told about.
          detail = {
            ...rebuilt,
            skippedCorpora: mergeSkippedCorpora(preRebuild, rebuilt),
            degradations: mergeRetrievalDegradations(preRebuild.degradations, rebuilt.degradations),
            laneAudits: [...preRebuild.laneAudits, ...rebuilt.laneAudits],
          };
          evidencePackMs += Date.now() - rebuildStartedAt;
        }
      }
      const pack = detail.pack;
      assertEvidencePackModelEligible(pack);
      const policyDeniedEmptyPack = pack.candidates.length === 0
        && (detail.policyDeniedCandidates ?? 0) > 0;

      const localOnly = pack.candidates.some(
        (candidate) => candidate.trustDomain === 'secure_local',
      );
      const requestedAnalystModel = request.analyst_model?.trim();
      const requestedAnalystProvider = request.analyst_provider ?? (requestedAnalystModel ? 'venice' : 'default');
      if (localOnly && requestedAnalystProvider === 'venice' && requestedAnalystModel) {
        assertSecureAnalystPoolModelIdAllowed('requested-venice', requestedAnalystModel);
      }
      const veniceAnalyst = policyDeniedEmptyPack
        ? undefined
        : createOptionalVeniceAnalyst(options, request).analyst;
      const secureCandidates = pack.candidates.filter((c) => c.trustDomain === 'secure_local');
      const internalCandidates = pack.candidates.filter((c) => c.trustDomain === 'internal');

      // Route by the owner's explicit provider choice when present. The default
      // remains the runtime-configured posture. The release gate below still
      // controls what Castor can see; provider choice controls only who reasons
      // over the internal EvidencePack. Secure packs may run raw on local or
      // venice (encrypted_cloud) analysts only. An explicitly requested
      // ordinary-cloud route is refused rather than silently changed to local.
      const analystStartedAt = Date.now();
      const routedAnalysis: RoutedAnalysis = policyDeniedEmptyPack
        ? { result: noEvidenceAnalystResult(pack), backend: 'local' as const }
        : await routeAnalysis({
            pack,
            localOnly,
            requestedProvider: requestedAnalystProvider,
            local: options.analyst,
            ...(options.cloudAnalyst ? { cloud: options.cloudAnalyst } : {}),
            ...(veniceAnalyst ? { venice: veniceAnalyst } : {}),
            // Trusted/encrypted-cloud bound only. request.timeout_ms is the OpenClaw
            // tool watchdog budget (the skill passes ~600s) — a DIFFERENT quantity;
            // it must never inflate this bound, or a ~20s Venice attempt silently
            // becomes a 10-minute one. (2026-07-15 answer-latency WO.)
            trustedAnalystTimeoutMs: options.trustedAnalystTimeoutMs ?? DEFAULT_TRUSTED_ANALYST_TIMEOUT_MS,
            localAnalystTimeoutMs: options.localAnalystTimeoutMs ?? DEFAULT_LOCAL_ANALYST_TIMEOUT_MS,
            cloudAnalystTimeoutMs: options.cloudAnalystTimeoutMs ?? DEFAULT_CLOUD_ANALYST_TIMEOUT_MS,
            ...(options.sovereigntyAnalystRoute ? { sovereigntyAnalystRoute: options.sovereigntyAnalystRoute } : {}),
            secureAnalystPoolState,
            ...(options.secureAnalystPool?.sloMs !== undefined
              ? { secureAnalystPoolSloMs: options.secureAnalystPool.sloMs }
              : {}),
            ...(options.secureAnalystPool?.reserveMs !== undefined
              ? { secureAnalystPoolReserveMs: options.secureAnalystPool.reserveMs }
              : {}),
            secureAnalystPoolLastLegTimeoutMs:
              options.secureAnalystPool?.lastLegTimeoutMs
              ?? DEFAULT_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS,
          });
      const {
        result: analystResult,
        backend: analystBackend,
        fallback: analystFallback,
        synthesizedGap,
      } = routedAnalysis;
      const analystMs = Date.now() - analystStartedAt;

      const releaseGateStartedAt = Date.now();
      const { decision, facts, opsec, answer } = releaseAnalystAnswer({
        detail,
        result: analystResult,
        releaseSecureContent,
        ...(synthesizedGap ? { synthesizedGap } : {}),
      });
      const releaseGateMs = Date.now() - releaseGateStartedAt;
      recordSourceAnswerReleaseDecision(decision.decision);

      const released = decision.decision === 'allow' || decision.decision === 'redact';

      const totalLatencyMs = Date.now() - startedAt;
      const phaseTimings = {
        lane_setup_ms: laneSetupMs,
        bulk_gate_ms: bulkGateMs,
        evidence_pack_ms: evidencePackMs,
        ...(selfHealMs !== undefined ? { self_heal_ms: selfHealMs } : {}),
        analyst_ms: analystMs,
        release_gate_ms: releaseGateMs,
        total_ms: totalLatencyMs,
      };
      recordSourceAnswerPhaseTimings(phaseTimings);
      return {
        answer,
        evidence: released
          ? releasedEvidence(analystResult.citations, detail, releaseSecureContent)
          : [],
        audit: {
          searched_corpora: [...pack.coverage.searchedCorpora],
          skipped_corpora: detail.skippedCorpora.map((skip) => ({
            corpus_id: skip.corpusId,
            trust_domain: skip.trustDomain,
            reason: skip.reason,
          })),
          lane_audits: [...detail.laneAudits],
          ...(detail.degradations.length > 0
            ? { retrieval_degradations: detail.degradations.map(answerRetrievalDegradation) }
            : {}),
          ...((detail.corpusReadabilityGaps ?? []).length > 0
            ? {
                corpus_readability: (detail.corpusReadabilityGaps ?? []).map((gap) => ({
                  corpus_id: gap.corpusId,
                  partial_documents: gap.partialDocuments,
                  unread_documents: gap.unreadDocuments,
                })),
              }
            : {}),
          ...(selfHealAudit ? { self_heal: selfHealAudit } : {}),
          answer_synthesis: {
            private_context_used: localOnly,
            secure_local_items_consulted: secureCandidates.length,
            internal_content_used: internalCandidates.some((c) => c.chunks.length > 0),
            internal_items_consulted: internalCandidates.length,
            internal_content_failures: 0,
            analyst_backend: analystBackend,
            ...(requestedAnalystProvider !== 'default'
              ? { requested_analyst_provider: requestedAnalystProvider }
              : {}),
            ...(requestedAnalystModel ? { requested_analyst_model: requestedAnalystModel } : {}),
            ...(analystFallback ? { analyst_fallback: analystFallback } : {}),
            raw_source_exposed: false,
          },
          latency_ms: totalLatencyMs,
          phase_timings: phaseTimings,
          raw_source_exposed: false,
        },
        policy: {
          raw_source_exposed: false,
          source_packets_exposed: false,
          internal_content_exposed:
            released && facts.some((fact) => fact.sensitivity.trustDomain === 'internal'),
          secure_local_content_exposed:
            released
            && facts.some(
              (fact) =>
                fact.sensitivity.trustDomain === 'secure_local'
                && fact.releaseSurface === 'castor_answer',
            ),
          castor_safe_bridge: true,
        },
        opsec,
      };
    },
  };
}

/**
 * The request's requested-corpus list, resolved through the shared registry so
 * a documented input alias names the same corpus every comparison downstream
 * uses. This is the seam rather than the route parser because the route accepts
 * both corpus_id and a corpus_ids[] array, and rather than the router's
 * comparison because all three consumers of this list compare against registry
 * corpus ids: lane selection, the secure_local targeting check, and the bulk
 * secure_local release gate. Resolving here fixes the retrieval false negative
 * and the two release-gate comparisons at once.
 *
 * Canonicalising before the Set is what makes dedupe survive: naming one corpus
 * twice, once by each of its ids, searches it once rather than twice. That
 * ordering has no observable effect through the router, which visits each
 * registry corpus once however many times it was named, so it is exported and
 * asserted directly - otherwise the requirement would have no test that can
 * fail.
 */
export function sourceAnswerCorpusIds(request: SourceIndexAnswerRequest): string[] | undefined {
  const ids = request.corpus_ids?.length ? [...request.corpus_ids] : [];
  if (request.corpus_id) ids.unshift(request.corpus_id);
  const unique = [...new Set(
    ids.map((id) => id.trim()).filter(Boolean).map((id) => canonicalSourceCorpusId(id)),
  )];
  return unique.length > 0 ? unique : undefined;
}

function requestExplicitlyTargetsSecureLocal(
  request: SourceIndexAnswerRequest,
  registry: SourceIndexCorpusRegistry,
): boolean {
  if (request.include_secure_local_content === true) return true;
  if (request.approved_scope_key?.trim()) return true;
  if (/\bsecure[-_\s]?local\b|\bs4\b/i.test(`${request.question} ${request.query ?? ''}`)) return true;
  const requestedCorpusIds = sourceAnswerCorpusIds(request) ?? [];
  if (requestedCorpusIds.some((corpusId) => corpusIsSecureLocal(corpusId, registry))) return true;
  return (request.selected_items ?? []).some((item) => corpusIsSecureLocal(item.corpus_id, registry));
}

function corpusIsSecureLocal(corpusId: string, registry: SourceIndexCorpusRegistry): boolean {
  const trimmed = corpusId.trim();
  const corpus = registry.get(trimmed);
  return corpus?.trustDomain === 'secure_local' || trimmed.startsWith('secure_local.');
}

function secureLocalApprovalScopeForBulkRequest(
  request: SourceIndexAnswerRequest,
  includeSecureLocal: boolean,
  registry: SourceIndexCorpusRegistry,
): { requiresApproval: boolean; corpusIds: string[] } {
  if (!includeSecureLocal || !isBulkSecureLocalReleaseRequest(request)) {
    return { requiresApproval: false, corpusIds: [] };
  }
  const selectedCorpusIds = new Set((request.selected_items ?? []).map((item) => item.corpus_id));
  const secureCorpusIds = registry.select({ trustDomains: ['secure_local'] }).map((corpus) => corpus.corpusId);
  const requestedCorpusIds = sourceAnswerCorpusIds(request);
  if (requestedCorpusIds) {
    const requestedSecure = requestedCorpusIds.filter((corpusId) => {
      return corpusIsSecureLocal(corpusId, registry);
    });
    return { requiresApproval: requestedSecure.length > 0, corpusIds: requestedSecure };
  }
  if (selectedCorpusIds.size > 0) {
    const selectedSecure = [...selectedCorpusIds].filter((corpusId) => {
      return corpusIsSecureLocal(corpusId, registry);
    });
    return { requiresApproval: selectedSecure.length > 0, corpusIds: selectedSecure };
  }
  if (request.approved_scope_key) {
    return { requiresApproval: true, corpusIds: secureCorpusIds };
  }
  return { requiresApproval: secureCorpusIds.length > 0, corpusIds: secureCorpusIds };
}

function isBulkSecureLocalReleaseRequest(request: SourceIndexAnswerRequest): boolean {
  const text = stripBulkAndRawDisclosureProhibitions(`${request.question} ${request.query ?? ''}`).toLowerCase();
  if (/\b(export|dump|download|bulk|archive)\b/.test(text)) return true;
  if (/\b(full text|raw text|verbatim)\b/.test(text)) return true;
  if (/\b(copy|show|give|list|print|return)\b.{0,50}\b(all|everything|entire|full|raw|verbatim)\b/.test(text)) return true;
  if (/\b(all|everything|entire|full|raw|verbatim)\b.{0,50}\b(content|text)\b/.test(text)) return true;
  if (
    /\b(all|everything|entire|full|raw|verbatim)\b.{0,50}\b(records?|documents?|files|data|source|sources)\b/.test(text)
    && !isBoundedDerivativeQuestion(text)
  ) {
    return true;
  }
  return false;
}

function stripBulkAndRawDisclosureProhibitions(text: string): string {
  return text.replace(
    /\b(?:do not|don't|never|without|must not|should not)\b[^.!?\n]{0,240}\b(?:raw|verbatim|source text|source content|source packets?|raw db|raw databases?|dump|export|download|bulk|archive)\b[^.!?\n]*/gi,
    ' ',
  );
}

function isBoundedDerivativeQuestion(text: string): boolean {
  const asksForSynthesis = /\b(what|which|why|how|answer|summari[sz]e|analy[sz]e|compare|trend|interpret|explain)\b/.test(text)
    || /\bsays?\s+about\b/.test(text);
  const hasTopicConstraint = /\b(?:about|regarding|related to|with respect to|for)\b\s+[^.!?\n]{2,160}/.test(text);
  return asksForSynthesis && hasTopicConstraint;
}

function createOptionalVeniceAnalyst(
  options: AnalystSourceIndexAnswerHandlerOptions,
  request: SourceIndexAnswerRequest,
): { analyst?: Analyst; error?: unknown } {
  try {
    const analyst = options.veniceAnalyst?.(request);
    return analyst ? { analyst } : {};
  } catch (error) {
    return { error };
  }
}

function selectedEvidenceItemsFromRequest(request: SourceIndexAnswerRequest): SelectedEvidenceItem[] {
  return (request.selected_items ?? []).map((item) => {
    const selected: SelectedEvidenceItem = {
      // selected_items carries its own request-supplied corpus id, and the
      // evidence pack looks it up with registry.get. An unresolved alias there
      // drops the item as 'no_adapter' - the same silent false negative as an
      // unresolved corpus_ids entry, so it resolves through the same registry.
      corpusId: canonicalSourceCorpusId(item.corpus_id),
      sourceItem: {
        family: item.family as SelectedEvidenceItem['sourceItem']['family'],
        provider: item.provider,
        accountScope: item.account_scope,
        providerItemId: item.provider_item_id,
        localItemId: item.local_item_id,
        ...(item.provider_thread_id ? { providerThreadId: item.provider_thread_id } : {}),
        ...(item.provider_conversation_id ? { providerConversationId: item.provider_conversation_id } : {}),
        ...(item.provider_file_id ? { providerFileId: item.provider_file_id } : {}),
        ...(item.source_version ? { sourceVersion: item.source_version } : {}),
      },
      ...(
        item.conversation_label
        || item.author_label
        || item.authored_at
          ? {
              citation: {
                ...(item.conversation_label ? { conversationLabel: item.conversation_label } : {}),
                ...(item.author_label ? { authorLabel: item.author_label } : {}),
                ...(item.authored_at ? { authoredAt: item.authored_at } : {}),
              },
            }
          : {}
      ),
    };
    return selected;
  });
}

function answerRetrievalDegradation(
  degradation: RetrievalDegradation,
): SourceIndexAnswerRetrievalDegradation {
  return {
    lane_name: degradation.laneName,
    lane_type: degradation.laneType,
    reason: degradation.reason,
    ...(degradation.detail ? { detail: degradation.detail } : {}),
    occurrences: degradation.occurrences,
  };
}

function mergeSkippedCorpora(
  ...details: readonly EvidencePackBuildDetail[]
): readonly SourceIndexSkippedCorpus[] {
  const merged = new Map<string, SourceIndexSkippedCorpus>();
  for (const detail of details) {
    for (const skip of detail.skippedCorpora) {
      merged.set(`${skip.corpusId}:${skip.reason}`, skip);
    }
  }
  return [...merged.values()];
}

// Analyst routing with the HARD MEMBRANE and availability fallback.
//
// The membrane (the single most important invariant): the cloud analyst must
// NEVER receive a secure_local candidate's content. Defense in depth:
//   1. canUseCloud requires !localOnly. localOnly is true for ANY secure_local
//      candidate, so this alone keeps secure packs local.
//   2. A redundant runtime assertion re-derives the absence of secure_local
//      from the pack itself. If localOnly were ever miscomputed upstream, this
//      catches it and forces the local lane. This is a real check, not a
//      comment — every cloud route is gated on it.
// Fallback: ordinary provider availability errors may route to local so an
// answer is not lost just because a remote lane is down. Typed policy refusals
// are never fallback events and must propagate unchanged.
interface RouteAnalysisInput {
  pack: EvidencePack;
  localOnly: boolean;
  requestedProvider: SourceAnswerAnalystProvider;
  local: Analyst;
  cloud?: Analyst;
  venice?: Analyst;
  trustedAnalystTimeoutMs: number;
  localAnalystTimeoutMs: number;
  cloudAnalystTimeoutMs: number;
  sovereigntyAnalystRoute?: (input: {
    pack: EvidencePack;
    localOnly: boolean;
    requestedProvider: SourceAnswerAnalystProvider;
  }) => SovereigntyAnalystRouteStep[] | SovereigntyAnalystRoutePlan;
  secureAnalystPoolState: SecureAnalystPoolState;
  secureAnalystPoolSloMs?: number;
  secureAnalystPoolReserveMs?: number;
  secureAnalystPoolLastLegTimeoutMs: number;
}

interface RoutedAnalysis {
  result: AnalystResult;
  backend: AnalystBackend;
  fallback?: SourceIndexAnalystFallback;
  /**
   * Set only when the worker synthesized this result instead of an analyst
   * producing it. The release gate cannot tell the two apart from the text —
   * both read as "I could not answer" — so the discriminator travels with the
   * result and names the real cause in the opsec reason.
   */
  synthesizedGap?: 'secure_local_metadata_only_gap';
}

export interface SovereigntyAnalystRouteStep {
  profile: SovereigntyResolvedProfile;
  backend: AnalystBackend;
  analyst: Analyst;
}

export interface SovereigntyAnalystRoutePlan {
  poolId: string;
  trustDomain: SourceTrustDomain;
  selection: SecureAnalystPoolSelection;
  steps: SovereigntyAnalystRouteStep[];
}

function analystRouteTraceStep(step: SovereigntyAnalystRouteStep): {
  profile_id: string;
  backend: AnalystBackend;
  model_id: string;
} {
  return {
    profile_id: step.profile.id,
    backend: step.backend,
    model_id: step.profile.profile.model,
  };
}

function implicitTraceStep(backend: AnalystBackend): {
  profile_id: string;
  backend: AnalystBackend;
  model_id: string;
} {
  return {
    profile_id: `implicit_${backend}`,
    backend,
    model_id: 'unreported',
  };
}

function implicitAnalystRoute(input: {
  requestedProvider: SourceAnswerAnalystProvider;
  canUseCloud: boolean;
  noSecureLocal: boolean;
  hasVenice: boolean;
}): Array<{ profile_id: string; backend: AnalystBackend; model_id: string }> {
  if (input.requestedProvider === 'local') {
    return [implicitTraceStep('local')];
  }
  if (input.requestedProvider === 'venice') {
    return [implicitTraceStep('venice'), implicitTraceStep('local')];
  }
  if (
    (input.requestedProvider === 'cloud' || input.requestedProvider === 'default')
    && input.canUseCloud
    && input.noSecureLocal
  ) {
    return [implicitTraceStep('cloud'), implicitTraceStep('local')];
  }
  return [implicitTraceStep('local')];
}

function observeImplicitAnalystLeg<T>(
  backend: AnalystBackend,
  budgetMs: number,
  run: () => Promise<T>,
): Promise<T> {
  return observeSourceAnswerAnalystLeg({
    ...implicitTraceStep(backend),
    budgetMs,
  }, run);
}

async function routeAnalysis(input: RouteAnalysisInput): Promise<RoutedAnalysis> {
  const {
    pack,
    localOnly,
    requestedProvider,
    local,
    cloud,
    venice,
    trustedAnalystTimeoutMs,
    localAnalystTimeoutMs,
    cloudAnalystTimeoutMs,
    sovereigntyAnalystRoute,
    secureAnalystPoolState,
    secureAnalystPoolSloMs,
    secureAnalystPoolReserveMs,
    secureAnalystPoolLastLegTimeoutMs,
  } = input;
  assertEvidencePackModelEligible(pack);
  const canUseCloud = !localOnly && cloud !== undefined;

  // MEMBRANE GUARD (defense in depth): even though localOnly already implies
  // it, re-prove from the pack that no candidate is secure_local before any
  // cloud call. An explicit ordinary-cloud request is a constraint: if the
  // pack makes that provider ineligible, refuse instead of silently changing
  // providers. Default routing keeps its configured availability fallbacks.
  const noSecureLocal = pack.candidates.every(
    (candidate) => candidate.trustDomain !== 'secure_local',
  );
  if (requestedProvider === 'cloud' && (localOnly || !noSecureLocal)) {
    recordSourceAnswerRoute(0, [implicitTraceStep('cloud')]);
    recordSourceAnswerSkippedAnalystLeg({
      ...implicitTraceStep('cloud'),
      budgetMs: 0,
      errorClass: 'SecureEvidencePolicySkip',
      outcome: 'policy_skipped',
    });
    throw new OperationError(
      'source_index_policy_violation',
      'The explicitly requested standard-cloud analyst is not eligible for secure-local evidence.',
      'Use the default secure route, local, or an approved Venice analyst for secure-local evidence.',
    );
  }

  if (sovereigntyAnalystRoute) {
    let routePlan: SovereigntyAnalystRoutePlan;
    const routeStartedAt = Date.now();
    try {
      const resolvedRoute = sovereigntyAnalystRoute({
        pack,
        localOnly,
        requestedProvider,
      });
      routePlan = Array.isArray(resolvedRoute)
        ? {
            poolId: localOnly ? 'secure_local:legacy' : 'ordinary:legacy',
            trustDomain: localOnly
              ? 'secure_local'
              : pack.candidates.some((candidate) => candidate.trustDomain === 'internal')
                ? 'internal'
                : 'public_safe',
            selection: 'explicit_order',
            steps: resolvedRoute,
          }
        : resolvedRoute;
    } catch (error) {
      recordSourceAnswerRoute(Date.now() - routeStartedAt, []);
      const metadataOnlyGap = secureMetadataOnlyGapResult(error, pack);
      if (metadataOnlyGap) {
        return {
          result: metadataOnlyGap,
          backend: 'local',
          synthesizedGap: 'secure_local_metadata_only_gap',
        };
      }
      throw error;
    }
    const plannedRoute = routePlan.trustDomain === 'secure_local'
      ? secureAnalystPoolState.plan(
          routePlan.poolId,
          routePlan.steps.map((step) => ({
            ...step,
            id: step.profile.id,
          })),
          routePlan.selection,
        )
      : {
          dispatch: routePlan.steps.map((step) => ({ ...step, id: step.profile.id })),
          breakerSkipped: [],
        };
    for (const step of plannedRoute.breakerSkipped) {
      recordSourceAnswerSkippedAnalystLeg({
        ...analystRouteTraceStep(step),
        budgetMs: 0,
        errorClass: 'AnalystCircuitOpen',
        outcome: 'breaker_skipped',
      });
    }
    recordSourceAnswerRoute(
      Date.now() - routeStartedAt,
      [...plannedRoute.dispatch, ...plannedRoute.breakerSkipped]
        .map((step) => analystRouteTraceStep(step)),
    );
    const routed = await routeAnalysisThroughSovereignty({
      pack,
      localOnly,
      requestedProvider,
      local,
      route: plannedRoute.dispatch,
      poolId: routePlan.poolId,
      trustDomain: routePlan.trustDomain,
      secureAnalystPoolState,
      trustedAnalystTimeoutMs,
      localAnalystTimeoutMs,
      cloudAnalystTimeoutMs,
      noSecureLocal,
      ...(secureAnalystPoolSloMs !== undefined ? { secureAnalystPoolSloMs } : {}),
      ...(secureAnalystPoolReserveMs !== undefined ? { secureAnalystPoolReserveMs } : {}),
      secureAnalystPoolLastLegTimeoutMs,
    });
    return routed;
  }

  recordSourceAnswerRoute(0, implicitAnalystRoute({
    requestedProvider,
    canUseCloud,
    noSecureLocal,
    hasVenice: venice !== undefined,
  }));

  if (requestedProvider === 'local') {
    const result = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
      analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
    return { result, backend: 'local' };
  }

  if (requestedProvider === 'venice' && venice) {
    const attemptStartedAt = Date.now();
    try {
      const attempt = await observeImplicitAnalystLeg('venice', trustedAnalystTimeoutMs, () =>
        analyzeWithTimeout(venice, pack, { localOnly }, trustedAnalystTimeoutMs));
      if (localOnly && attempt.result.escalation) {
        const fallback = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
          analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
        return {
          result: fallback,
          backend: 'local',
          fallback: analystFallback('venice', 'escalation', {
            elapsedMs: attempt.elapsedMs,
            timeoutMs: attempt.timeoutMs,
          }),
        };
      }
      return { result: attempt.result, backend: 'venice' };
    } catch (error) {
      if (isAnalystPolicyRefusal(error)) throw error;
      // Explicit Venice failed; fall back to local so the request still has a
      // privacy-preserving answer path, and report the actual backend used.
      const fallback = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
        analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
      return {
        result: fallback,
        backend: 'local',
        fallback: analystFallback('venice', fallbackReason('venice', error), {
          elapsedMs: trustedAnalystElapsedMs(error, attemptStartedAt),
          timeoutMs: trustedAnalystTimeoutMs,
        }),
      };
    }
  }
  if (requestedProvider === 'venice' && !venice) {
    recordSourceAnswerSkippedAnalystLeg({
      ...implicitTraceStep('venice'),
      budgetMs: trustedAnalystTimeoutMs,
      errorClass: 'AnalystUnavailable',
      outcome: 'unavailable',
    });
    const fallback = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
      analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
    return {
      result: fallback,
      backend: 'local',
      fallback: {
        from: 'venice',
        to: 'local',
        reason: 'unavailable',
      },
    };
  }

  if (requestedProvider === 'cloud' && canUseCloud && noSecureLocal && cloud) {
    const attemptStartedAt = Date.now();
    try {
      const result = await observeImplicitAnalystLeg('cloud', cloudAnalystTimeoutMs, () =>
        analyzeWithOptionalTimeout(cloud, pack, { localOnly }, cloudAnalystTimeoutMs));
      return { result, backend: 'cloud' };
    } catch (error) {
      const fallback = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
        analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
      return {
        result: fallback,
        backend: 'local',
        fallback: analystFallback('cloud', fallbackReason('cloud', error), {
          elapsedMs: Math.max(0, Date.now() - attemptStartedAt),
        }),
      };
    }
  }
  if (requestedProvider === 'cloud') {
    recordSourceAnswerSkippedAnalystLeg({
      ...implicitTraceStep('cloud'),
      budgetMs: 0,
      errorClass: localOnly || !noSecureLocal
        ? 'SecureEvidencePolicySkip'
        : 'AnalystUnavailable',
      outcome: localOnly || !noSecureLocal ? 'policy_skipped' : 'unavailable',
    });
    const fallback = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
      analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
    return {
      result: fallback,
      backend: 'local',
      fallback: {
        from: 'cloud',
        to: 'local',
        reason: 'unavailable',
      },
    };
  }

  if (requestedProvider === 'default' && canUseCloud && noSecureLocal && cloud) {
    const attemptStartedAt = Date.now();
    try {
      const result = await observeImplicitAnalystLeg('cloud', cloudAnalystTimeoutMs, () =>
        analyzeWithOptionalTimeout(cloud, pack, { localOnly }, cloudAnalystTimeoutMs));
      return { result, backend: 'cloud' };
    } catch (error) {
      // FALLBACK: any cloud failure (transport, HTTP, parse) drops to local.
      // The answer must never fail just because the cloud lane is down.
      const fallback = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
        analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
      return {
        result: fallback,
        backend: 'local',
        fallback: analystFallback('cloud', fallbackReason('cloud', error), {
          elapsedMs: Math.max(0, Date.now() - attemptStartedAt),
        }),
      };
    }
  }

  const result = await observeImplicitAnalystLeg('local', localAnalystTimeoutMs, () =>
    analyzeWithOptionalTimeout(local, pack, { localOnly }, localAnalystTimeoutMs));
  return { result, backend: 'local' };
}

function secureMetadataOnlyGapResult(error: unknown, pack: EvidencePack): AnalystResult | undefined {
  if (!(error instanceof OperationError)) return undefined;
  if (error.code !== 'config_error' || !/route for secure_local is disabled/i.test(error.message)) return undefined;
  if (!pack.candidates.some((candidate) => candidate.trustDomain === 'secure_local')) return undefined;
  if (pack.candidates.some((candidate) => candidate.trustDomain === 'secure_local' && candidate.chunks.length > 0)) {
    return undefined;
  }
  const extractionGaps = pack.coverage.extractionGaps.filter(Boolean);
  return {
    answer: 'secure_local_metadata_only_gap: I found secure-local source metadata, but I could not answer from source content because this install is configured to keep secure-classified content metadata-only until a local or encrypted-cloud secure lane is configured.',
    citations: [],
    unanswered: [
      error.suggestion ?? error.message,
      ...extractionGaps,
    ],
  };
}

async function routeAnalysisThroughSovereignty(input: {
  pack: EvidencePack;
  localOnly: boolean;
  requestedProvider: SourceAnswerAnalystProvider;
  local: Analyst;
  route: Array<SovereigntyAnalystRouteStep & { id?: string }>;
  poolId: string;
  trustDomain: SourceTrustDomain;
  secureAnalystPoolState: SecureAnalystPoolState;
  trustedAnalystTimeoutMs: number;
  localAnalystTimeoutMs: number;
  cloudAnalystTimeoutMs: number;
  noSecureLocal: boolean;
  secureAnalystPoolSloMs?: number;
  secureAnalystPoolReserveMs?: number;
  secureAnalystPoolLastLegTimeoutMs: number;
}): Promise<RoutedAnalysis> {
  if (input.route.length === 0) {
    throw new Error('Sovereignty analyst route is empty; refusing to fall through to another trust class.');
  }
  let lastFallback: SourceIndexAnalystFallback | undefined;
  const legOutcomes: string[] = [];
  const secureLegBudgets = input.trustDomain === 'secure_local'
    ? deriveSecureAnalystPoolLegBudgets(
        input.route.map((step) => ({ id: step.profile.id, backend: step.backend })),
        {
          trustedAnalystTimeoutMs: input.trustedAnalystTimeoutMs,
          localAnalystTimeoutMs: input.localAnalystTimeoutMs,
          ...(input.secureAnalystPoolSloMs !== undefined
            ? { sloMs: input.secureAnalystPoolSloMs }
            : {}),
          ...(input.secureAnalystPoolReserveMs !== undefined
            ? { reserveMs: input.secureAnalystPoolReserveMs }
            : {}),
        },
      )
    : undefined;
  for (const [routeIndex, step] of input.route.entries()) {
    const traceStep = analystRouteTraceStep(step);
    const isLastAvailableSecureLeg =
      input.trustDomain === 'secure_local'
      && routeIndex === input.route.length - 1;
    // A failed non-final attempt can move cheaply to the next member. Once the
    // dispatch plan reaches its final available member, interruption would
    // turn otherwise-finishing work into route exhaustion, so use the separate
    // completion budget. Breaker-open members were removed before this route.
    const budgetMs = isLastAvailableSecureLeg
      ? input.secureAnalystPoolLastLegTimeoutMs
      : secureLegBudgets?.get(step.profile.id)
        ?? (step.backend === 'venice'
          ? input.trustedAnalystTimeoutMs
          : step.backend === 'local'
            ? input.localAnalystTimeoutMs
            : input.cloudAnalystTimeoutMs);
    // Secure packs may only run on sovereignty-approved non-standard-cloud
    // steps: local, or encrypted_cloud (Venice) when the config routes it.
    // Profile spoof defenses live in sovereignty validation (local trust
    // requires loopback baseUrl + local provider).
    if (
      (input.localOnly || !input.noSecureLocal)
      && (step.backend === 'cloud' || step.profile.profile.trust === 'standard_cloud')
    ) {
      if (step.backend !== 'local') {
        lastFallback = { from: step.backend, to: 'local', reason: `${step.backend}_local_only` };
      }
      recordSourceAnswerSkippedAnalystLeg({
        ...traceStep,
        budgetMs,
        errorClass: 'SecureEvidencePolicySkip',
      });
      legOutcomes.push(`${step.backend}: skipped by policy (secure evidence in pack; standard cloud not eligible)`);
      continue;
    }
    // Spoof guard: a step claiming local trust with a non-local provider is
    // never dispatched for a pack with secure candidates. Config validation
    // rejects such profiles at load; this covers hand-built routes.
    if (
      (input.localOnly || !input.noSecureLocal)
      && step.profile.profile.trust === 'local'
      && step.profile.profile.provider !== 'local-openai-compatible'
    ) {
      recordSourceAnswerSkippedAnalystLeg({
        ...traceStep,
        budgetMs,
        errorClass: 'LocalTrustProviderMismatch',
      });
      legOutcomes.push(`${step.backend}: skipped (local trust claimed by non-local provider)`);
      continue;
    }
    const attemptStartedAt = Date.now();
    try {
      if (step.backend === 'venice') {
        const attempt = await observeSourceAnswerAnalystLeg({
          ...traceStep,
          budgetMs,
        }, () => analyzeWithTimeout(
            step.analyst,
            input.pack,
            { localOnly: input.localOnly },
            budgetMs,
          ));
        if (input.trustDomain === 'secure_local') {
          input.secureAnalystPoolState.recordSuccess(
            input.poolId,
            step.profile.id,
            attempt.elapsedMs,
          );
        }
        return { result: attempt.result, backend: 'venice', ...(lastFallback ? { fallback: lastFallback } : {}) };
      }
      // Every non-venice backend takes the same bounded helper: local on the
      // generous local ceiling, ordinary cloud on the cloud bound. The helper
      // no-ops on a non-positive budget, so a step that computes no budget
      // keeps its unbounded behaviour rather than acquiring a surprise one.
      const result = await observeSourceAnswerAnalystLeg({
        ...traceStep,
        budgetMs,
      }, () => analyzeWithOptionalTimeout(
          step.analyst,
          input.pack,
          { localOnly: input.localOnly },
          budgetMs,
        ));
      if (input.trustDomain === 'secure_local') {
        input.secureAnalystPoolState.recordSuccess(
          input.poolId,
          step.profile.id,
          Math.max(0, Date.now() - attemptStartedAt),
        );
      }
      return { result, backend: step.backend, ...(lastFallback ? { fallback: lastFallback } : {}) };
    } catch (error) {
      if (isAnalystPolicyRefusal(error)) throw error;
      if (input.trustDomain === 'secure_local') {
        input.secureAnalystPoolState.recordFailure(input.poolId, step.profile.id);
      }
      legOutcomes.push(`${step.backend}:failed:${sourceAnswerTraceErrorClass(error)}`);
      console.error(
        `[analyst-route] leg failed backend=${step.backend} error_class=${sourceAnswerTraceErrorClass(error)}`,
      );
      lastFallback = step.backend === 'local'
        ? undefined
        : analystFallback(step.backend, fallbackReason(step.backend, error), {
            elapsedMs: step.backend === 'venice'
              ? trustedAnalystElapsedMs(error, attemptStartedAt)
              : Math.max(0, Date.now() - attemptStartedAt),
            ...(step.backend === 'venice' ? { timeoutMs: budgetMs } : {}),
          });
    }
  }
  throw new Error(
    `Sovereignty analyst fallback chain exhausted; route outcomes=${legOutcomes.join(',') || 'none'}.`,
  );
}

function isAnalystPolicyRefusal(error: unknown): error is OperationError {
  return error instanceof OperationError && error.code === 'source_index_policy_violation';
}

class TrustedAnalystTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(timeoutMs: number, elapsedMs: number) {
    // Backend-agnostic message: analyzeWithTimeout now bounds both the trusted
    // (Venice) lane and the local Argus lane, each with its own budget.
    super(`analyst timed out after ${timeoutMs}ms`);
    this.name = 'TrustedAnalystTimeoutError';
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

async function analyzeWithTimeout(
  analyst: Analyst,
  pack: EvidencePack,
  options: AnalystOptions,
  timeoutMs: number,
): Promise<{ result: AnalystResult; elapsedMs: number; timeoutMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let settled = false;
  const cancellationSettleMs = timeoutMs >= 2
    ? Math.min(10, Math.max(1, Math.floor(timeoutMs / 10)))
    : 0;
  const executionTimeoutMs = Math.max(1, timeoutMs - cancellationSettleMs);
  const analysis = runWithAnalystAbortSignal(
    controller.signal,
    () => analyst.analyze(pack, options),
  ).finally(() => {
    settled = true;
  });
  // A non-cooperative adapter can still outlive the bounded cancellation
  // settle window. Its rejection is always observed, while the content-free
  // trace counter makes any residual orphan measurable.
  analysis.catch(() => {});
  try {
    const result = await Promise.race([
      analysis,
      new Promise<AnalystResult>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          const timeoutError = new TrustedAnalystTimeoutError(
            timeoutMs,
            Date.now() - startedAt,
          );
          reject(timeoutError);
          const abortError = new Error('Analyst leg budget expired.');
          abortError.name = 'AbortError';
          controller.abort(abortError);
        }, executionTimeoutMs);
      }),
    ]);
    return { result, elapsedMs: Date.now() - startedAt, timeoutMs };
  } catch (error) {
    if (!timedOut) throw error;
    if (!settled) {
      if (cancellationSettleMs > 0) {
        await Promise.race([
          analysis.then(() => undefined, () => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, cancellationSettleMs)),
        ]);
      } else {
        await Promise.resolve();
      }
    }
    if (!settled) recordSourceAnswerResidualAnalystOrphan();
    if (error instanceof TrustedAnalystTimeoutError) throw error;
    throw new TrustedAnalystTimeoutError(timeoutMs, Date.now() - startedAt);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Bound an analyst call with the budget its lane was given. On expiry this
// throws the shared timeout error naming the budget + elapsed, so a wedged
// model fails honestly instead of silently riding the tool watchdog to its
// full length. A non-positive / non-finite budget disables the bound.
async function analyzeWithOptionalTimeout(
  analyst: Analyst,
  pack: EvidencePack,
  options: AnalystOptions,
  timeoutMs: number,
): Promise<AnalystResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return analyst.analyze(pack, options);
  }
  return (await analyzeWithTimeout(analyst, pack, options, timeoutMs)).result;
}

function fallbackReason(
  from: Exclude<AnalystBackend, 'local'>,
  error: unknown,
): SourceIndexAnalystFallback['reason'] {
  if (error instanceof TrustedAnalystTimeoutError) return 'timeout';
  return providerErrorReason(from, error);
}

function analystFallback(
  from: Exclude<AnalystBackend, 'local'>,
  reason: SourceIndexAnalystFallback['reason'],
  diagnostics: { elapsedMs?: number; timeoutMs?: number } = {},
): SourceIndexAnalystFallback {
  return {
    from,
    to: 'local',
    reason,
    ...(diagnostics.elapsedMs !== undefined ? { elapsed_ms: diagnostics.elapsedMs } : {}),
    ...(diagnostics.timeoutMs !== undefined ? { timeout_ms: diagnostics.timeoutMs } : {}),
  };
}

function trustedAnalystElapsedMs(error: unknown, startedAt: number): number {
  return error instanceof TrustedAnalystTimeoutError
    ? error.elapsedMs
    : Math.max(0, Date.now() - startedAt);
}

function providerErrorReason(
  from: Exclude<AnalystBackend, 'local'>,
  error: unknown,
): SourceIndexAnalystFallback['reason'] {
  if (error instanceof OperationError) {
    const httpStatus = /\bHTTP\s+(\d{3})\b/i.exec(error.message)?.[1];
    if (httpStatus) return `${from}_http_${httpStatus}`;
    if (
      /did not include message content/i.test(error.message)
      || /completion budget exhausted during reasoning/i.test(error.message)
    ) {
      return `${from}_empty_content`;
    }
    if (/non-JSON response/i.test(error.message)) return `${from}_non_json`;
    if (/unreachable/i.test(error.message)) return `${from}_unreachable`;
    if (/requires an apiKey/i.test(error.message)) return `${from}_config`;
  }
  return `${from}_error`;
}

// Shared release step: analyst result -> gate facts -> decision -> audit. Used
// by the handler above and by the real held-out eval runner (eval/run-real.ts)
// so privacy grading exercises the same gate the live path uses. Analyst
// escalations never release source content; local insufficiency becomes a
// coverage gap, while real approval/secret escalations stay gated.
export interface AnalystReleaseInput {
  detail: EvidencePackBuildDetail;
  result: AnalystResult;
  releaseSecureContent: boolean;
  // Names the worker-synthesized cause when the result is not a model answer.
  // A `//` comment, not a one-line `/** … */`: the architecture guard's regex
  // detector reads `/** … */` on one line as a regex literal, and every other
  // file it enrolls comments the same way.
  synthesizedGap?: string;
}

export interface AnalystReleaseOutcome {
  decision: ReleaseDecision;
  facts: StructuredEvidenceFact[];
  opsec: OpsecReleaseAudit;
  answer: string;
}

export function releaseAnalystAnswer(input: AnalystReleaseInput): AnalystReleaseOutcome {
  const facts = factsFromCitations(input.result.citations, input.detail, input.releaseSecureContent);
  const nonPublicPack = input.detail.pack.candidates.some(
    (candidate) => candidate.trustDomain !== 'public_safe',
  );
  const unreadableMatchedGaps = safeUnreadableMatchedCoverageGaps(input.detail);
  const releasedEvidenceCount = releasedEvidence(
    input.result.citations,
    input.detail,
    input.releaseSecureContent,
  ).length;
  const originalDraftAnswer = composeReleasedAnswer(input.result.answer, input.result.unanswered);
  const uncitedNonPublicAnswer =
    !input.result.escalation
    && nonPublicPack
    && facts.length === 0
    && originalDraftAnswer.trim().length > 0;
  const releasedUnanswered = appendUniqueCoverageNotes(
    sanitizeReleasedCoverageNotes(input.result.unanswered, input.detail, nonPublicPack),
    [
      ...unreadableMatchedGaps,
      ...(input.result.unanswered.length === 0 && releasedEvidenceCount === 0
        ? zeroEvidenceCoverageNotes(input.detail.pack)
        : []),
      // Gated on the released evidence count ALONE — deliberately not also on
      // the model having reported no gaps of its own, the way the note above
      // is. "I could not find that" beside a document with pages nobody could
      // read is the exact pairing this note exists to break up, so the model
      // listing its own unanswered items must never be what suppresses it.
      ...(releasedEvidenceCount === 0
        ? corpusReadabilityCoverageNotes(input.detail)
        : []),
    ],
  );
  const safeUnsupportedAnswer = 'I found matching source material, but I could not extract a cited bounded answer from it in this pass.';
  const unsupportedNoContent = uncitedNonPublicAnswer && isUnsupportedNoContentAnswer(input.result);
  const safeUnsupportedDraft = composeReleasedAnswer(
    safeUnsupportedAnswer,
    safeUnsupportedCoverageGaps(input.detail.pack, nonPublicPack),
  );
  const finalDraftAnswer = composeReleasedAnswer(
    unsupportedNoContent ? safeUnsupportedDraft : input.result.answer,
    unsupportedNoContent ? [] : releasedUnanswered,
  );
  const originalScanDecision = finalDraftAnswer === originalDraftAnswer
    ? undefined
    : evaluateReleaseGate({
        facts,
        draftAnswer: originalDraftAnswer,
        destination: 'castor',
        action: 'answer',
        caller: 'worker',
      });
  const finalScanDecision = () =>
    releaseDecisionWithReason(
      evaluateReleaseGate({
        facts,
        draftAnswer: finalDraftAnswer,
        destination: 'castor',
        action: 'answer',
        caller: 'worker',
      }),
      finalDraftAnswer === originalDraftAnswer ? 'release_gate_passed' : 'non_public_coverage_notes_sanitized',
    );
  const decision: ReleaseDecision = input.result.escalation
    ? isUnsupportedNoContentAnswer(input.result)
      ? scannedUnsupportedNoContentDecision({
          facts,
          originalDraftAnswer,
          safeUnsupportedDraft,
          reason: 'analyst_insufficient_no_source_content',
        })
      : {
          decision: 'needs_approval',
          reasons: ['analyst_escalation_proposed', 'local_answer_insufficient'],
          requiredApproval: 's4_release',
        }
    : uncitedNonPublicAnswer && isUnsupportedNoContentAnswer(input.result)
      ? scannedUnsupportedNoContentDecision({
          facts,
          originalDraftAnswer,
          safeUnsupportedDraft,
          reason: input.synthesizedGap ?? 'unsupported_answer_released_without_source_content',
        })
    : uncitedNonPublicAnswer
      ? {
          decision: 'needs_approval',
          reasons: ['uncited_non_public_answer'],
          requiredApproval: packHasSecureLocal(input.detail.pack) ? 's4_release' : 'user_review',
        }
    : originalScanDecision && originalScanDecision.decision !== 'allow'
      ? originalScanDecision
    : finalScanDecision();
  return {
    decision,
    facts,
    opsec: buildOpsecReleaseAudit(facts, decision),
    answer: answerForReleaseDecision(decision),
  };
}

function scannedUnsupportedNoContentDecision(input: {
  facts: StructuredEvidenceFact[];
  originalDraftAnswer: string;
  safeUnsupportedDraft: string;
  reason: string;
}): ReleaseDecision {
  const scanned = evaluateReleaseGate({
    facts: input.facts,
    draftAnswer: input.originalDraftAnswer,
    destination: 'castor',
    action: 'answer',
    caller: 'worker',
  });
  if (scanned.decision !== 'allow') {
    return releaseDecisionWithReason(scanned, input.reason);
  }
  const safeScanned = evaluateReleaseGate({
    facts: input.facts,
    draftAnswer: input.safeUnsupportedDraft,
    destination: 'castor',
    action: 'answer',
    caller: 'worker',
  });
  return releaseDecisionWithReason(
    safeScanned.decision === 'allow'
      ? { ...safeScanned, allowedText: input.safeUnsupportedDraft }
      : safeScanned,
    input.reason,
  );
}

function releaseDecisionWithReason(decision: ReleaseDecision, reason: string): ReleaseDecision {
  return {
    ...decision,
    reasons: decision.reasons.includes(reason)
      ? [...decision.reasons]
      : [reason, ...decision.reasons],
  };
}

function composeReleasedAnswer(answer: string, unanswered: readonly string[]): string {
  if (unanswered.length === 0) return answer;
  return `${answer}\n\nCoverage notes:\n${unanswered.map((gap) => `- ${gap}`).join('\n')}`;
}

function zeroEvidenceCoverageNotes(pack: EvidencePack): string[] {
  const corpusIds = [...new Set(
    pack.coverage.searchedCorpora
      .map((corpusId) => corpusId.trim())
      .filter(Boolean),
  )].sort();
  if (corpusIds.length === 0) return [];
  return [
    `No supporting evidence was found in the searched corpora for this question: ${corpusIds.join(', ')}.`,
  ];
}

/**
 * Counts-only, corpus-ids-only — the same convention zeroEvidenceCoverageNotes
 * follows, and for the same reason: this rides out on a released answer that
 * may be reaching an ordinary cloud caller, so it may say how much of the
 * corpus could not be read and never which documents or where they live.
 *
 * One note for all corpora rather than one per corpus, so a deployment with
 * several partly-read sources still gets a sentence rather than a list.
 */
function corpusReadabilityCoverageNotes(detail: EvidencePackBuildDetail): string[] {
  const gaps = (detail.corpusReadabilityGaps ?? [])
    .filter((gap) => gap.partialDocuments > 0 || gap.unreadDocuments > 0);
  if (gaps.length === 0) return [];
  const described = [...gaps]
    .sort((a, b) => a.corpusId.localeCompare(b.corpusId))
    .map((gap) => {
      const parts: string[] = [];
      if (gap.partialDocuments > 0) {
        parts.push(`${gap.partialDocuments} with unread pages`);
      }
      if (gap.unreadDocuments > 0) {
        parts.push(`${gap.unreadDocuments} with no extracted text`);
      }
      return `${gap.corpusId} (${parts.join(', ')})`;
    });
  return [
    `Not everything in the searched corpora could be read: ${described.join('; ')}. `
    + 'Content inside those documents is not searchable, so finding nothing here '
    + 'is not evidence that the material is absent.',
  ];
}

function sanitizeReleasedCoverageNotes(
  unanswered: readonly string[],
  detail: EvidencePackBuildDetail,
  nonPublicPack: boolean,
): string[] {
  if (unanswered.length === 0) return [];
  if (!nonPublicPack) return [...unanswered];
  const categories = new Set<string>(['coverage']);
  if (detail.pack.coverage.extractionGaps.some((gap) => gap.trim().length > 0)) {
    categories.add('extraction/readability');
  }
  if ((detail.corpusReadabilityGaps ?? []).some(
    (gap) => gap.partialDocuments > 0 || gap.unreadDocuments > 0,
  )) {
    categories.add('readability');
  }
  const categoryText = [...categories].sort().join(' and ');
  return [
    `${unanswered.length} non-public ${categoryText} gap${unanswered.length === 1 ? '' : 's'} ` +
    'affected this answer; ' +
    'raw filenames, paths, and source content were withheld.',
  ];
}

function safeUnsupportedCoverageGaps(pack: EvidencePack, nonPublicPack: boolean): string[] {
  const gaps = pack.coverage.extractionGaps.filter((gap) => gap.trim().length > 0);
  if (gaps.length === 0) {
    // The safe-unsupported release factually released zero citable evidence.
    // Carry a mechanical, corpus-ids-only coverage note so the honest
    // non-answer is machine-recognizable as a genuine gap (same convention
    // and derivation as zeroEvidenceCoverageNotes; no question or source
    // content).
    const corpusIds = [...new Set(
      pack.coverage.searchedCorpora
        .map((corpusId) => corpusId.trim())
        .filter(Boolean),
    )].sort();
    if (corpusIds.length === 0) return [];
    return [
      `No citable supporting evidence could be released from the searched corpora for this question: ${corpusIds.join(', ')}.`,
    ];
  }
  if (!nonPublicPack) return gaps;
  return [`${gaps.length} source item${gaps.length === 1 ? '' : 's'} could not be read or extracted in this pass.`];
}

function safeUnreadableMatchedCoverageGaps(detail: EvidencePackBuildDetail): string[] {
  const count = unreadableMatchedCandidateIndexes(detail).length;
  if (count === 0) return [];
  return [
    `${count} matched file${count === 1 ? '' : 's'} found, but ` +
    `${count === 1 ? 'it could' : 'they could'} not be read or extracted in this pass.`,
  ];
}

function appendUniqueCoverageNotes(
  notes: readonly string[],
  additions: readonly string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const note of [...notes, ...additions]) {
    const normalized = note.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isUnsupportedNoContentAnswer(result: AnalystResult): boolean {
  if (result.citations.length > 0) return false;
  const text = [result.answer, ...result.unanswered].join(' ').toLowerCase();
  return (
    /\bno\b.{0,80}\b(evidence|source|sources|support|supports|supported|matching|match|answer)\b/.test(text) ||
    /\bnothing\b.{0,80}\b(evidence|source|sources|support|supports|supported|found|matches)\b/.test(text) ||
    /\b(evidence|source|sources)\b.{0,80}\b(does not|do not|doesn't|don't|cannot|can't|could not|doesn’t|don’t)\b.{0,80}\b(contain|support|answer)\b/.test(text) ||
    /\b(cannot|can't|could not|unable to)\b.{0,80}\b(answer|determine|confirm)\b/.test(text)
    || /\b(insufficient|uncertain|not enough)\b.{0,80}\b(evidence|source|sources|text|content|context|answer|securely)\b/.test(text)
  );
}

function packHasSecureLocal(pack: EvidencePack): boolean {
  return pack.candidates.some((candidate) => candidate.trustDomain === 'secure_local');
}

// Each analyst citation becomes a structured evidence fact for the release
// gate: the claim is the model's bounded derivative, the sensitivity comes from
// the cited candidate's trust tags, and secure_local claims are only marked
// releasable when the request explicitly asked for secure content.
function factsFromCitations(
  citations: readonly AnalystCitation[],
  detail: EvidencePackBuildDetail,
  releaseSecureContent: boolean,
): StructuredEvidenceFact[] {
  return citations.flatMap((citation, index) => {
    const candidateIndex = candidateIndexForCitation(citation, detail);
    if (candidateIndex === -1) return [];
    const candidate = detail.pack.candidates[candidateIndex]!;
    const secure = candidate.trustDomain === 'secure_local';
    return [
      createStructuredEvidenceFact({
        factId: `citation-${index + 1}`,
        claim: citation.claim,
        sourceProvenance: [citation.provenance],
        sensitivity: buildSourceSensitivity({
          trustTier: candidate.trustTier,
          trustDomain: candidate.trustDomain,
        }),
        confidence: 'medium',
        extractionKind: 'paraphrase',
        ...(secure && !releaseSecureContent ? { releaseSurface: 'local_only' as const } : {}),
      }),
    ];
  });
}

function evidenceFromCitations(
  citations: readonly AnalystCitation[],
  detail: EvidencePackBuildDetail,
): SourceIndexAnswerEvidence[] {
  const seen = new Set<string>();
  const evidence: SourceIndexAnswerEvidence[] = [];
  for (const citation of citations) {
    const candidateIndex = candidateIndexForCitation(citation, detail);
    if (candidateIndex === -1) continue;
    const candidate = detail.pack.candidates[candidateIndex]!;
    const corpusId = detail.candidateCorpusIds[candidateIndex] ?? 'unknown';
    const item = citation.provenance.sourceItem;
    const key = `${corpusId}:${item.providerItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cite = citation.provenance.citation;
    evidence.push({
      corpus_id: corpusId,
      trust_domain: candidate.trustDomain,
      family: item.family,
      provider: item.provider,
      provider_item_id: item.providerItemId,
      ...(item.providerThreadId ? { provider_thread_id: item.providerThreadId } : {}),
      ...(item.providerConversationId ? { provider_conversation_id: item.providerConversationId } : {}),
      ...(item.providerFileId ? { provider_file_id: item.providerFileId } : {}),
      ...(cite?.title ? { title: cite.title } : {}),
      ...(cite?.sourceLabel ? { source_label: cite.sourceLabel } : {}),
      ...(cite?.conversationLabel ? { conversation_label: cite.conversationLabel } : {}),
      ...(cite?.authorLabel ? { author_label: cite.authorLabel } : {}),
      ...(cite?.uri ? { uri: cite.uri } : {}),
      ...(cite?.authoredAt ? { authored_at: cite.authoredAt } : {}),
      ...(cite?.updatedAt ? { updated_at: cite.updatedAt } : {}),
      ...citationSpanFields(citation.provenance),
    });
  }
  return evidence;
}

/**
 * The offset-level locator, taken from the provenance the retrieval lane
 * already built. Nothing is derived or guessed here: a lane that could not
 * locate a span leaves `chunk.span` absent and the released evidence stays at
 * item granularity, exactly as before.
 */
function citationSpanFields(
  provenance: SourceIndexProvenance,
): { citation_span?: SourceIndexAnswerCitationSpan } {
  const chunk = provenance.chunk;
  const span = chunk?.span;
  if (!chunk || !span) return {};
  return {
    citation_span: {
      chunk_index: chunk.chunkIndex,
      chunk_id: chunk.chunkId,
      char_start: span.charStart,
      char_end: span.charEnd,
      item_char_start: span.itemCharStart,
      item_char_end: span.itemCharEnd,
      chunk_chars: span.chunkChars,
      lane: span.lane,
    },
  };
}

function releasedEvidence(
  citations: readonly AnalystCitation[],
  detail: EvidencePackBuildDetail,
  releaseSecureContent: boolean,
): SourceIndexAnswerEvidence[] {
  const cited = evidenceFromCitations(citations, detail);
  return appendUnreadableMatchedEvidence(cited, detail, releaseSecureContent);
}

/**
 * These entries never become facts, so the release gate never scans them: an
 * unreadable secure_local match would otherwise hand its real filename and
 * locator to the caller under the strict posture, where a cited one from the
 * same file is withheld. The count-only coverage gap still reports it.
 */
function appendUnreadableMatchedEvidence(
  evidence: SourceIndexAnswerEvidence[],
  detail: EvidencePackBuildDetail,
  releaseSecureContent: boolean,
): SourceIndexAnswerEvidence[] {
  const seen = new Set(evidence.map(evidenceKey));
  for (const index of unreadableMatchedCandidateIndexes(detail)) {
    const candidate = detail.pack.candidates[index]!;
    if (candidate.trustDomain === 'secure_local' && !releaseSecureContent) continue;
    const item = candidate.provenance.sourceItem;
    const corpusId = detail.candidateCorpusIds[index] ?? 'unknown';
    const entry: SourceIndexAnswerEvidence = {
      corpus_id: corpusId,
      trust_domain: candidate.trustDomain,
      family: item.family,
      provider: item.provider,
      provider_item_id: item.providerItemId,
      ...(item.providerThreadId ? { provider_thread_id: item.providerThreadId } : {}),
      ...(item.providerConversationId ? { provider_conversation_id: item.providerConversationId } : {}),
      ...(item.providerFileId ? { provider_file_id: item.providerFileId } : {}),
      ...(candidate.provenance.citation?.title ? { title: candidate.provenance.citation.title } : {}),
      ...(candidate.provenance.citation?.sourceLabel ? { source_label: candidate.provenance.citation.sourceLabel } : {}),
      ...(candidate.provenance.citation?.conversationLabel
        ? { conversation_label: candidate.provenance.citation.conversationLabel }
        : {}),
      ...(candidate.provenance.citation?.authorLabel
        ? { author_label: candidate.provenance.citation.authorLabel }
        : {}),
      ...(candidate.provenance.citation?.uri ? { uri: candidate.provenance.citation.uri } : {}),
      ...(candidate.provenance.citation?.authoredAt ? { authored_at: candidate.provenance.citation.authoredAt } : {}),
      ...(candidate.provenance.citation?.updatedAt ? { updated_at: candidate.provenance.citation.updatedAt } : {}),
      ...citationSpanFields(candidate.provenance),
    };
    const key = evidenceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(entry);
  }
  return evidence;
}

function unreadableMatchedCandidateIndexes(detail: EvidencePackBuildDetail): number[] {
  if (detail.pack.coverage.extractionGaps.length === 0) return [];
  return detail.pack.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.provenance.sourceItem.family === 'file')
    .filter(({ candidate }) => {
      return candidate.chunks.length === 0
        && (candidate.tables?.length ?? 0) === 0
        && (candidate.facts?.length ?? 0) === 0;
    })
    .map(({ index }) => index);
}

function evidenceKey(evidence: SourceIndexAnswerEvidence): string {
  return [
    evidence.corpus_id,
    evidence.provider_item_id,
    evidence.provider_thread_id ?? '',
    evidence.provider_file_id ?? '',
  ].join(':');
}

function candidateIndexForCitation(citation: AnalystCitation, detail: EvidencePackBuildDetail): number {
  const byIdentity = detail.pack.candidates.findIndex(
    (candidate) => candidate.provenance === citation.provenance,
  );
  if (byIdentity !== -1) return byIdentity;
  const citationCorpusId = provenanceCorpusId(citation.provenance);
  const matches = detail.pack.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      sourceItemsEqual(candidate.provenance.sourceItem, citation.provenance.sourceItem),
    );
  if (citationCorpusId) {
    const byCorpus = matches.filter(({ candidate, index }) =>
      (detail.candidateCorpusIds[index] ?? provenanceCorpusId(candidate.provenance)) === citationCorpusId,
    );
    return byCorpus.length === 1 ? byCorpus[0]!.index : -1;
  }
  return matches.length === 1 ? matches[0]!.index : -1;
}

function provenanceCorpusId(provenance: SourceIndexProvenance): string | undefined {
  return provenance.localIds?.corpus_id
    ?? provenance.localIds?.corpusId
    ?? provenance.providerIds?.corpus_id
    ?? provenance.providerIds?.corpusId;
}

function sourceItemsEqual(left: SourceItemIdentity, right: SourceItemIdentity): boolean {
  return left.family === right.family
    && left.provider === right.provider
    && left.accountScope === right.accountScope
    && left.providerItemId === right.providerItemId
    && left.providerThreadId === right.providerThreadId
    && left.providerConversationId === right.providerConversationId
    && left.providerFileId === right.providerFileId
    && left.providerEventId === right.providerEventId
    && left.localItemId === right.localItemId
    && left.sourceVersion === right.sourceVersion;
}
