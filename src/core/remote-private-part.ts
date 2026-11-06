/**
 * The Private part of a remote agent's source answer or evidence search
 * (summary-rule agents: every remote connection that is not ChatGPT). Design
 * docs/design/background-agents.md, section A, "When one is recorded".
 *
 * The typed outcome comes from the answer's actual release decision (its
 * opsec audit) and from the final remote release (core/remote-result.ts,
 * after slice 2's recheck), never from synthesis fields alone:
 * - `delivered`: the release gate allowed the answer, it drew on Private
 *   items (secure_local_items_consulted > 0), and the remote release is
 *   `answered`. Nothing is recorded.
 * - `approval_required`: the release gate asked for approval (a bulk
 *   request, or Private facts not marked for release); nothing Private left.
 * - `withheld`: the release gate denied the answer, or the remote release
 *   withheld it.
 * - `excluded_by_policy`: Private was left out by the owner's policy (no
 *   approved private analyst route).
 * - `route_unavailable`: the private route was down and the answer fell back
 *   to Public and Personal.
 * Anything else (`none`: the caller turned Private off, nothing Private was
 * in scope, or the answer was released without Private) records nothing.
 *
 * For every outcome but `delivered` and `none`, a local, metadata-only match
 * probe (source-index/analyst-answer.ts probePrivateMatch) decides whether
 * anything Private matches the same request: `match` records a waiting
 * question and, once it is recorded, adds one fixed sentence to an answered
 * result (REMOTE_PRIVATE_NOTE, core/remote-result.ts); `unknown` (a Private
 * corpus not checked, a timeout or an error) records it as "couldn't check
 * yet", retried locally (retryUnchecked), and the agent is told nothing;
 * `no_match` records nothing. Policy is never bypassed: the probe's verdict
 * goes nowhere but the local record and that one sentence.
 *
 * A source_answer that hands off to a job is settled when the job finishes
 * (core/source-answer-jobs.ts whenFinished), with the asking request and the
 * revocation ticket read when it began, whether or not anyone collects it.
 * A collector (source_answer_result) only reads that settled verdict.
 *
 * The evidence search (`olympus_search`, workers/remote-search.ts) is the
 * only tool a standard install offers these agents, and it never returns
 * Private items, so it has no outcome to wait for: every question is probed,
 * with the same probe, the same ticket and the same record (surface
 * 'remote', no selector but the retrieval mode). The probe starts when the
 * call does, beside the search, bounded by probeTimeoutMs, so it adds no wait
 * to a search that takes longer; settle then reads its verdict, and a
 * `match` that was recorded adds the same sentence and Open link. A search
 * the agent cancels records nothing: settle stops waiting when the request's
 * signal aborts, and the record step re-reads the signal in the same
 * synchronous turn it writes in, so a late verdict writes no row, spends none
 * of the connection's automatic answers and takes no Inbox slot.
 *
 * Revocation: the connection store's `isActive` is asked before a probe and
 * before each re-probe, the store refuses a recording for a connection it
 * does not vouch for, and each re-check pass reconciles the store against
 * it, which retries a revoking process's failed cleanup. `close` stops any
 * pass in flight and any settle still waiting.
 */
import { remoteOperationOutput } from './remote-result.ts';
import type { ReleaseCheck } from './release-manifest.ts';
import type { SourceAnswerJobScope } from './source-answer-jobs.ts';
import type { WaitingQuestionRef, WaitingQuestionStore, WaitingQuestionTicket } from './waiting-private-questions.ts';
import { normalizeWaitingSelectors } from './waiting-private-questions.ts';

export type RemotePrivateOutcome =
  | 'delivered'
  | 'approval_required'
  | 'withheld'
  | 'excluded_by_policy'
  | 'route_unavailable'
  | 'none';
export type PrivateMatchVerdict = 'match' | 'secret_match' | 'no_match' | 'unknown';

/** What the surface knows about the call, beyond its arguments. */
export interface RemotePrivatePartContext {
  /** The call's hand-off scope: a handed-off answer is settled when its job finishes. */
  jobs?: SourceAnswerJobScope;
  /** The worker's current tiers and release rules, for a finished job's remote release. */
  releaseCheck?: ReleaseCheck;
  /**
   * The agent's request signal (the evidence search only). A search the agent
   * cancelled records nothing: settle stops waiting at once, and a verdict that
   * arrives after the cancellation is ignored.
   */
  signal?: AbortSignal;
}

/** The worker's per-call hook, set on the remote surface's OperationContext. */
export interface RemotePrivatePart {
  /**
   * Called before the operation runs (the revocation ticket is read now).
   * Undefined when this operation has no Private part to settle.
   */
  start(
    operation: string,
    args: Readonly<Record<string, unknown>>,
    context?: RemotePrivatePartContext,
  ): RemotePrivatePartCall | undefined;
}

export interface RemotePrivatePartCall {
  /** Opaque local row locator, never a capability or answer. */
  readonly answerId?: string | undefined;
  readonly secretMatch?: boolean | undefined;
  /**
   * Settles the call's raw result, given the remote output it releases:
   * records a waiting question when the outcome and the probe say so. True
   * only when the probe found a match and the question was recorded, so an
   * answered output carries the fixed sentence. Never throws.
   */
  settle(raw: unknown, released: Readonly<Record<string, unknown>> | undefined): Promise<boolean>;
}

const POLICY_REASON = 'no_private_analyst_route';
const BULK_REASON = 'bulk_secure_local_release_requires_approval';
const UNAVAILABLE_REASON = 'private_analyst_unavailable';
const PROBED: ReadonlySet<RemotePrivateOutcome> = new Set([
  'approval_required',
  'withheld',
  'excluded_by_policy',
  'route_unavailable',
]);
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
/**
 * A re-check of a "couldn't check yet" record has no search waiting on it, so
 * it may wait on the local model's keyword translation (a new wording needs
 * one, and a CPU-only computer takes several seconds to make it).
 */
const DEFAULT_RETRY_PROBE_TIMEOUT_MS = 20_000;

// A handed-off job's lifetime (core/source-answer-jobs.ts SOURCE_ANSWER_JOB_DEADLINE_MS plus its TTL).
const DEFAULT_HANDOFF_TTL_MS = 35 * 60_000;
const MAX_HANDOFFS = 200;

/**
 * The pending value, or undefined the moment the signal aborts (at once when it
 * already has). The abort listener is removed as soon as the wait ends either way.
 */
function untilCancelled<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The Private part's outcome for a raw source answer (source-index/
 * analyst-answer.ts) and the remote output released for it
 * (core/remote-result.ts). Without the released output nothing counts as
 * delivered.
 */
export function remotePrivateOutcome(
  raw: unknown,
  released?: Readonly<Record<string, unknown>>,
): RemotePrivateOutcome {
  const record = asRecord(raw);
  if (!record || typeof record.answer !== 'string') return 'none';
  // A location-only Secret is never delivered remotely, even when another
  // part of the answer was released. Re-probe it before recording a pointer.
  if (Array.isArray(record.secret_locations) && record.secret_locations.length > 0) return 'excluded_by_policy';
  const audit = asRecord(record.audit);
  if (!audit) return 'none';
  const decision = asRecord(asRecord(record.opsec)?.release_decision)?.decision;
  const reasons = Array.isArray(audit.skipped_corpora)
    ? audit.skipped_corpora.map((skip) => asRecord(skip)?.reason).filter((reason): reason is string => typeof reason === 'string')
    : [];
  if (decision === 'needs_approval' || reasons.includes(BULK_REASON)) return 'approval_required';
  if (decision === 'deny') return 'withheld';
  if (released !== undefined && released.status !== 'answered') return 'withheld';
  const consulted = asRecord(audit.answer_synthesis)?.secure_local_items_consulted;
  if (
    (decision === 'allow' || decision === 'redact')
    && released?.status === 'answered'
    && typeof consulted === 'number'
    && consulted > 0
  ) return 'delivered';
  if (reasons.includes(UNAVAILABLE_REASON)) return 'route_unavailable';
  if (reasons.includes(POLICY_REASON)) return 'excluded_by_policy';
  return 'none';
}

export interface RemotePrivatePartsOptions {
  /** The local metadata-only probe over the request's own selectors. */
  probe: (request: Record<string, unknown>, timeoutMs: number) => Promise<PrivateMatchVerdict>;
  /** The waiting-question store (opened lazily); undefined records nothing. */
  store: () => Pick<WaitingQuestionStore, 'ticket' | 'record' | 'unchecked' | 'settleUnchecked' | 'revokeConnection' | 'reconcileConnections'> | undefined;
  /**
   * Whether a connection is active now (the connection store's word); throws
   * when that cannot be read. Absent: every connection counts as active.
   */
  isActive?: (connectionId: string) => boolean;
  probeTimeoutMs?: number;
  /** The bound of a re-check (retryUnchecked), far longer than a search's: nobody is waiting. */
  retryProbeTimeoutMs?: number;
  /**
   * True while the owner's own work is in flight. A re-check pass starts no
   * probe then, so background checking never competes with it.
   */
  interactiveBusy?: () => boolean;
  handoffTtlMs?: number;
  now?: () => number;
}

export interface RemotePrivateParts {
  /** The hook for calls by one connection. */
  forConnection(connectionId: string): RemotePrivatePart;
  /**
   * One re-check pass: reconciles the store against the connection store,
   * then re-probes every "couldn't check yet" record of an active connection
   * once, with the longer retry bound; `unknown` leaves it for the next pass.
   * One pass at a time; it yields to the owner's own work (interactiveBusy).
   */
  retryUnchecked(): Promise<{ matched: number; cleared: number; still: number }>;
  /** Stops a pass in flight and any settle still waiting; nothing is probed or recorded after. */
  close(): void;
}

interface Handoff {
  expiresAt: number;
  settled: Promise<boolean>;
  answerId?: string;
  secretMatch?: boolean;
}

/**
 * The worker's remote Private-part hooks. Plain closures, no class: this
 * module is reachable from the bundled CLI, and class-field initializers
 * balloon the committed dist/.
 */
export function createRemotePrivateParts(options: RemotePrivatePartsOptions): RemotePrivateParts {
  const now = options.now ?? Date.now;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const retryProbeTimeoutMs = options.retryProbeTimeoutMs ?? DEFAULT_RETRY_PROBE_TIMEOUT_MS;
  const handoffTtlMs = options.handoffTtlMs ?? DEFAULT_HANDOFF_TTL_MS;
  const handoffs = new Map<string, Handoff>();
  let closed = false;
  let pass: Promise<{ matched: number; cleared: number; still: number }> | undefined;

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

  /** True only when the connection store vouches for the connection now. */
  const activeNow = (connectionId: string): boolean => {
    if (!options.isActive) return true;
    try {
      return options.isActive(connectionId) === true;
    } catch {
      return false;
    }
  };

  const probe = async (request: Record<string, unknown>, timeoutMs: number): Promise<PrivateMatchVerdict> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.probe(request, timeoutMs),
        new Promise<PrivateMatchVerdict>((resolve) => {
          timer = setTimeout(() => resolve('unknown'), timeoutMs);
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
    released: Readonly<Record<string, unknown>> | undefined,
    args: Readonly<Record<string, unknown>>,
    ticket: WaitingQuestionTicket | undefined,
    recordedId?: (id: string, secretMatch: boolean) => void,
  ): Promise<boolean> => {
    try {
      if (closed || !ticket) return false;
      if (!PROBED.has(remotePrivateOutcome(raw, released))) return false;
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      // Selectors that cannot be stored exactly are not recorded at all, so a
      // later replay never searches wider than the agent asked.
      const selectors = normalizeWaitingSelectors(args);
      if (!question || !selectors) return false;
      if (!activeNow(ticket.connectionId)) return false;
      const verdict = await probe({ ...selectors, question }, probeTimeoutMs);
      if (verdict === 'no_match' || closed) return false;
      return recordVerdict(ticket, question, selectors, verdict, recordedId);
    } catch {
      return false;
    }
  };

  /**
   * Records a question the probe did not clear: waiting on a match, "couldn't
   * check yet" on `unknown`. True only for a match that was recorded: the
   * sentence says the answer can be seen on the computer, so only when the
   * question really waits there (not refused by a revocation or its bounds).
   */
  const recordVerdict = (
    ticket: WaitingQuestionTicket,
    question: string,
    selectors: NonNullable<ReturnType<typeof normalizeWaitingSelectors>>,
    verdict: 'match' | 'secret_match' | 'unknown',
    recordedId?: (id: string, secretMatch: boolean) => void,
  ): boolean => {
    let recorded = false;
    try {
      const ref = options.store()?.record(ticket, {
        question,
        surface: 'remote',
        state: verdict === 'unknown' ? 'unchecked' : 'waiting',
        selectors,
      });
      recorded = ref !== undefined;
      if (ref) recordedId?.(ref.id, verdict === 'secret_match');
    } catch {
      console.warn('[olympus:remote] waiting private question not recorded reason=store_unavailable');
    }
    return verdict !== 'unknown' && recorded;
  };

  /**
   * The evidence search's Private part. The ticket is read and the probe
   * started now, before the search runs; settle (after the search) reads the
   * verdict, asks the connection store again, and records. A search that fails
   * never settles, so nothing is recorded for it, and one the agent cancelled
   * records nothing either (`signal`).
   */
  const startSearch = (connectionId: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): RemotePrivatePartCall => {
    const ticket = ticketFor(connectionId);
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    // The search takes the question alone, so nothing narrows a replay of it.
    const selectors = normalizeWaitingSelectors({});
    let answerId: string | undefined;
    let secretMatch = false;
    // Never left unhandled: when the search fails, or is cancelled, nothing reads this.
    const verdict: Promise<PrivateMatchVerdict | undefined> = (async () => {
      if (closed || signal?.aborted || !ticket || !question || !selectors) return undefined;
      if (!activeNow(ticket.connectionId)) return undefined;
      return probe({ ...selectors, question }, probeTimeoutMs);
    })().catch(() => undefined);
    return {
      get answerId() { return answerId; },
      get secretMatch() { return secretMatch; },
      async settle() {
        try {
          const found = await untilCancelled(verdict, signal);
          // The cancellation is read in the turn that records, so a verdict that lands
          // after it (or a wait it cut short) writes nothing.
          if (signal?.aborted) return false;
          if (found === undefined || found === 'no_match' || closed || !ticket || !selectors) return false;
          // The probe may have waited: a connection revoked meanwhile records nothing.
          if (!activeNow(ticket.connectionId)) return false;
          return recordVerdict(ticket, question, selectors, found, (id, secret) => { answerId = id; secretMatch = secret; });
        } catch {
          return false;
        }
      },
    };
  };

  /** A handed-off answer, settled when its job finishes, collected or not. */
  const settleWhenFinished = (
    jobs: SourceAnswerJobScope | undefined,
    jobId: string,
    args: Readonly<Record<string, unknown>>,
    ticket: WaitingQuestionTicket | undefined,
    releaseCheck: ReleaseCheck | undefined,
    recordedId?: (id: string, secretMatch: boolean) => void,
  ): Promise<boolean> | undefined => {
    let finished: ReturnType<SourceAnswerJobScope['registry']['whenFinished']>;
    try {
      finished = jobs?.registry.whenFinished(jobs.owner, jobId);
    } catch {
      finished = undefined;
    }
    if (!finished) return undefined;
    return finished.then(async (outcome) => {
      if (!outcome.ok || closed) return false;
      let released: Record<string, unknown> | undefined;
      try {
        // The release the agent would be handed now: slice 2's recheck may withhold it.
        released = remoteOperationOutput('source_answer', outcome.value, {
          ...(releaseCheck ? { releaseCheck } : {}),
          releaseManifests: outcome.releaseManifests,
        });
      } catch {
        released = { status: 'error' };
      }
      return settleAnswer(outcome.value, released, args, ticket, recordedId);
    }).catch(() => false);
  };

  const runPass = async (): Promise<{ matched: number; cleared: number; still: number }> => {
    const counts = { matched: 0, cleared: 0, still: 0 };
    let store: ReturnType<RemotePrivatePartsOptions['store']>;
    try {
      store = options.store();
    } catch {
      return counts;
    }
    if (!store || closed) return counts;
    // A revoking process whose own cleanup failed is caught up here. An
    // unreadable connection store skips this pass: nothing is removed on a
    // read failure.
    if (options.isActive) {
      try {
        store.reconcileConnections(options.isActive);
      } catch {
        // Next pass.
      }
    }
    let records: ReturnType<WaitingQuestionStore['unchecked']>;
    try {
      records = store.unchecked();
    } catch {
      return counts;
    }
    for (const record of records) {
      if (closed) break;
      if (options.isActive) {
        let active: boolean;
        try {
          active = options.isActive(record.connectionId) === true;
        } catch {
          counts.still += 1;
          continue;
        }
        if (!active) {
          try {
            store.revokeConnection(record.connectionId);
            counts.cleared += 1;
          } catch {
            counts.still += 1;
          }
          continue;
        }
      }
      // Background checking never competes with the owner's own work: the
      // record stays for the next pass.
      let ownerBusy = false;
      try {
        ownerBusy = options.interactiveBusy?.() === true;
      } catch {
        // Unreadable: check anyway.
      }
      if (ownerBusy) {
        counts.still += 1;
        continue;
      }
      const verdict = await probe({ ...record.selectors, question: record.question }, retryProbeTimeoutMs);
      if (closed) break;
      if (verdict === 'unknown') {
        counts.still += 1;
        continue;
      }
      const ref: WaitingQuestionRef = { id: record.id, generation: record.generation, connectionId: record.connectionId };
      try {
        if (store.settleUnchecked(ref, verdict === 'secret_match' ? 'match' : verdict)) {
          if (verdict !== 'no_match') counts.matched += 1;
          else counts.cleared += 1;
        }
      } catch {
        counts.still += 1;
      }
    }
    return counts;
  };

  return {
    forConnection(connectionId) {
      return {
        start(operation, args, context) {
          if (operation === 'olympus_search') return startSearch(connectionId, args, context?.signal);
          if (operation === 'source_answer') {
            const ticket = ticketFor(connectionId);
            let answerId: string | undefined;
            let secretMatch = false;
            return {
              get answerId() { return answerId; },
              get secretMatch() { return secretMatch; },
              async settle(raw, released) {
                const pending = asRecord(raw);
                if (pending?.status === 'working' && typeof pending.job_id === 'string') {
                  const settled = settleWhenFinished(context?.jobs, pending.job_id, args, ticket, context?.releaseCheck, (id, secret) => { answerId = id; secretMatch = secret; const handoff = handoffs.get(`${connectionId}\u0000${pending.job_id}`); if (handoff) { handoff.answerId = id; handoff.secretMatch = secret; } });
                  if (settled) {
                    sweep();
                    handoffs.set(`${connectionId}\u0000${pending.job_id}`, { settled, expiresAt: now() + handoffTtlMs });
                    sweep();
                  }
                  return false;
                }
                return settleAnswer(raw, released, args, ticket, (id, secret) => { answerId = id; secretMatch = secret; });
              },
            };
          }
          if (operation === 'source_answer_result') {
            const jobId = typeof args.job_id === 'string' ? args.job_id : undefined;
            if (!jobId) return undefined;
            return {
              get answerId() { return handoffs.get(`${connectionId}\u0000${jobId}`)?.answerId; },
              get secretMatch() { return handoffs.get(`${connectionId}\u0000${jobId}`)?.secretMatch; },
              async settle(raw) {
                sweep();
                const entry = handoffs.get(`${connectionId}\u0000${jobId}`);
                if (!entry || asRecord(raw)?.status === 'working') return false;
                // Settled when the job finished; the collector only reads it.
                return entry.settled;
              },
            };
          }
          return undefined;
        },
      };
    },

    retryUnchecked() {
      if (closed) return Promise.resolve({ matched: 0, cleared: 0, still: 0 });
      pass ??= runPass().finally(() => {
        pass = undefined;
      });
      return pass;
    },

    close() {
      closed = true;
      handoffs.clear();
    },
  };
}
