/**
 * The Private part of a remote agent's source answer (summary-rule agents:
 * every remote connection that is not ChatGPT). Design
 * docs/design/background-agents.md, section A, "When one is recorded".
 *
 * Three typed outcomes, read from the raw answer's audit:
 * - `delivered`: the summary drew on Private evidence. Nothing is recorded.
 * - `excluded_by_policy`: Private was left out by the owner's policy (no
 *   approved private analyst route, or a bulk request that would need release
 *   approval).
 * - `route_unavailable`: the private route was down and the answer fell back
 *   to Public and Personal.
 * Anything else (`none`: the caller turned Private off, or nothing Private
 * was in scope) records nothing.
 *
 * For the two fallback outcomes a local, metadata-only match probe decides
 * whether anything Private matches the same request: `match` records a
 * waiting question and, once it is recorded, adds one fixed sentence to the
 * agent's result (REMOTE_PRIVATE_NOTE, core/remote-result.ts); `unknown` (timeout or error)
 * records it as "couldn't check yet", retried locally (retryUnchecked), and
 * the agent is told nothing; `no_match` records nothing. Policy is never
 * bypassed: the probe's verdict goes nowhere but the local record and that
 * one sentence.
 *
 * A source_answer that handed off to a job is settled when its answer is
 * collected (source_answer_result): the asking request and its revocation
 * ticket are remembered per connection and job id, in memory, for the job's
 * lifetime.
 */
import type { WaitingQuestionRef, WaitingQuestionStore, WaitingQuestionTicket } from './waiting-private-questions.ts';
import { normalizeWaitingSelectors } from './waiting-private-questions.ts';

export type RemotePrivateOutcome = 'delivered' | 'excluded_by_policy' | 'route_unavailable' | 'none';
export type PrivateMatchVerdict = 'match' | 'no_match' | 'unknown';

/** The worker's per-call hook, set on the remote surface's OperationContext. */
export interface RemotePrivatePart {
  /**
   * Called before the operation runs (the revocation ticket is read now).
   * Undefined when this operation has no Private part to settle.
   */
  start(operation: string, args: Readonly<Record<string, unknown>>): RemotePrivatePartCall | undefined;
}

export interface RemotePrivatePartCall {
  /**
   * Settles the call's raw result: records a waiting question when the
   * outcome and the probe say so. True only when the probe found a match, so
   * the result carries the fixed sentence. Never throws.
   */
  settle(raw: unknown): Promise<boolean>;
}

const POLICY_REASONS: ReadonlySet<string> = new Set(['no_private_analyst_route', 'bulk_secure_local_release_requires_approval']);
const UNAVAILABLE_REASON = 'private_analyst_unavailable';
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
// A handed-off job's lifetime (core/source-answer-jobs.ts SOURCE_ANSWER_JOB_DEADLINE_MS plus its TTL).
const DEFAULT_HANDOFF_TTL_MS = 35 * 60_000;
const MAX_HANDOFFS = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The Private part's outcome for a raw source answer (source-index/analyst-answer.ts audit). */
export function remotePrivateOutcome(raw: unknown): RemotePrivateOutcome {
  const record = asRecord(raw);
  if (!record || typeof record.answer !== 'string') return 'none';
  const audit = asRecord(record.audit);
  if (!audit) return 'none';
  const synthesis = asRecord(audit.answer_synthesis);
  const consulted = synthesis?.secure_local_items_consulted;
  if (synthesis?.private_context_used === true || (typeof consulted === 'number' && consulted > 0)) return 'delivered';
  const reasons = Array.isArray(audit.skipped_corpora)
    ? audit.skipped_corpora.map((skip) => asRecord(skip)?.reason).filter((reason): reason is string => typeof reason === 'string')
    : [];
  if (reasons.includes(UNAVAILABLE_REASON)) return 'route_unavailable';
  if (reasons.some((reason) => POLICY_REASONS.has(reason))) return 'excluded_by_policy';
  return 'none';
}

export interface RemotePrivatePartsOptions {
  /** The local metadata-only probe over the request's own selectors. */
  probe: (request: Record<string, unknown>, timeoutMs: number) => Promise<PrivateMatchVerdict>;
  /** The waiting-question store (opened lazily); undefined records nothing. */
  store: () => Pick<WaitingQuestionStore, 'ticket' | 'record' | 'unchecked' | 'settleUnchecked'> | undefined;
  probeTimeoutMs?: number;
  handoffTtlMs?: number;
  now?: () => number;
}

export interface RemotePrivateParts {
  /** The hook for calls by one connection. */
  forConnection(connectionId: string): RemotePrivatePart;
  /** Re-probes every "couldn't check yet" record once; `unknown` leaves it for the next run. */
  retryUnchecked(): Promise<{ matched: number; cleared: number; still: number }>;
}

interface Handoff {
  args: Readonly<Record<string, unknown>>;
  ticket: WaitingQuestionTicket | undefined;
  expiresAt: number;
  settled?: Promise<boolean>;
}

/**
 * The worker's remote Private-part hooks. Plain closures, no class: this
 * module is reachable from the bundled CLI, and class-field initializers
 * balloon the committed dist/.
 */
export function createRemotePrivateParts(options: RemotePrivatePartsOptions): RemotePrivateParts {
  const now = options.now ?? Date.now;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const handoffTtlMs = options.handoffTtlMs ?? DEFAULT_HANDOFF_TTL_MS;
  const handoffs = new Map<string, Handoff>();

  const sweep = () => {
    const at = now();
    for (const [key, entry] of handoffs) if (entry.expiresAt <= at) handoffs.delete(key);
    while (handoffs.size > MAX_HANDOFFS) {
      const oldest = handoffs.keys().next().value;
      if (oldest === undefined) break;
      handoffs.delete(oldest);
    }
  };

  const ticketFor = (connectionId: string): WaitingQuestionTicket | undefined => {
    try {
      return options.store()?.ticket(connectionId);
    } catch {
      console.warn('[olympus:remote] waiting private question not recorded reason=store_unavailable');
      return undefined;
    }
  };

  const probe = async (request: Record<string, unknown>): Promise<PrivateMatchVerdict> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.probe(request, probeTimeoutMs),
        new Promise<PrivateMatchVerdict>((resolve) => {
          timer = setTimeout(() => resolve('unknown'), probeTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      return 'unknown';
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** The outcome, the probe and the record for one finished answer. */
  const settleAnswer = async (
    raw: unknown,
    args: Readonly<Record<string, unknown>>,
    ticket: WaitingQuestionTicket | undefined,
  ): Promise<boolean> => {
    try {
      const outcome = remotePrivateOutcome(raw);
      if (outcome !== 'excluded_by_policy' && outcome !== 'route_unavailable') return false;
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      // Selectors that cannot be stored exactly are not recorded at all, so a
      // later replay never searches wider than the agent asked.
      const selectors = normalizeWaitingSelectors(args);
      if (!question || !selectors) return false;
      const verdict = await probe({ ...selectors, question });
      if (verdict === 'no_match' || !ticket) return false;
      let recorded = false;
      try {
        recorded = options.store()?.record(ticket, {
          question,
          surface: 'remote',
          state: verdict === 'match' ? 'waiting' : 'unchecked',
          selectors,
        }) !== undefined;
      } catch {
        console.warn('[olympus:remote] waiting private question not recorded reason=store_unavailable');
      }
      // The sentence says the answer can be seen on the computer: only when
      // the question really waits there (not refused by a revocation or its
      // bounds).
      return verdict === 'match' && recorded;
    } catch {
      return false;
    }
  };

  return {
    forConnection(connectionId) {
      return {
        start(operation, args) {
          if (operation === 'source_answer') {
            const ticket = ticketFor(connectionId);
            return {
              async settle(raw) {
                const pending = asRecord(raw);
                if (pending?.status === 'working' && typeof pending.job_id === 'string') {
                  sweep();
                  handoffs.set(`${connectionId}\u0000${pending.job_id}`, { args, ticket, expiresAt: now() + handoffTtlMs });
                  sweep();
                  return false;
                }
                return settleAnswer(raw, args, ticket);
              },
            };
          }
          if (operation === 'source_answer_result') {
            const jobId = typeof args.job_id === 'string' ? args.job_id : undefined;
            if (!jobId) return undefined;
            return {
              async settle(raw) {
                sweep();
                const key = `${connectionId}\u0000${jobId}`;
                const entry = handoffs.get(key);
                if (!entry || asRecord(raw)?.status === 'working') return false;
                // A repeated collect of the same finished job gets the same
                // verdict without a second probe or record.
                entry.settled ??= settleAnswer(raw, entry.args, entry.ticket);
                return entry.settled;
              },
            };
          }
          return undefined;
        },
      };
    },

    async retryUnchecked() {
      const counts = { matched: 0, cleared: 0, still: 0 };
      let store: ReturnType<RemotePrivatePartsOptions['store']>;
      let records: ReturnType<WaitingQuestionStore['unchecked']>;
      try {
        store = options.store();
        records = store?.unchecked() ?? [];
      } catch {
        return counts;
      }
      for (const record of records) {
        const verdict = await probe({ ...record.selectors, question: record.question });
        if (verdict === 'unknown') {
          counts.still += 1;
          continue;
        }
        const ref: WaitingQuestionRef = { id: record.id, generation: record.generation, connectionId: record.connectionId };
        try {
          if (store?.settleUnchecked(ref, verdict)) {
            if (verdict === 'match') counts.matched += 1;
            else counts.cleared += 1;
          }
        } catch {
          counts.still += 1;
        }
      }
      return counts;
    },
  };
}
