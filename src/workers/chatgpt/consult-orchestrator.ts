/**
 * The consult orchestrator: gate → transport session → panel outside block
 * (design docs/design/frontier-consult-lane.md §A.2, §A.3, §A.7, §A.8 and
 * §A.5.6; stage C4b). One consult per delivered private answer, at most.
 *
 *   first delivery (jobs.onFirstDelivered)
 *     trigger: policy on, capability 2, state answer, block idle, verdict
 *       insufficient or gaps (not "these items do not answer"), panel
 *       recently active, dispatch window open with delivery room, snapshot
 *       held, consult not over                              any no → nothing
 *     markOutside pending                                   (the schedule mark)
 *     E1: every item the answer read still eligible         no → failed, snapshot dropped
 *     ┌ open the transport session (warm: lease, Tor, daemon, policy)   ┐ in parallel
 *     └ writer on its own server (memory rule, token bound, deadline)   ┘
 *     gate over the snapshot pack + question, answer, gaps  refuse → failed, silently
 *     session ready? busy or any failure → failed (never queued)
 *     send(question, authorize): settings revision, panel activity,
 *       window and delivery room, state, E2 eligibility, the send-once latch
 *     reply → appendOutsideBlock (fitted; question and route label)
 *     finished runs on in the background; the snapshot is dropped at the
 *       dispatch decision.
 *
 * A fresh private answer starting anywhere (jobs.onAnswerActivity) kills a
 * writer in flight (SIGKILL of the writer's own process; the answer server
 * is never touched) and the consult for that job ends; a dispatch already
 * past its writer is not interrupted. Every failure, skip
 * and refusal ends in `markOutside('failed')`: the block reads `idle` and
 * the panel shows nothing more. Verdicts and reasons are logged as codes
 * only, never as content, and never leave this machine.
 *
 * What may be shown to the writer: the question, the answer and the gaps
 * from the snapshot. Nothing else is ever passed to it.
 *
 * Money boundary: nothing is reserved before the transport's `authorize`
 * says yes; `authorize` runs synchronously before the reservation inside
 * the session (consult-transport-zkapi.ts). A `busy` or fenced transport
 * skips the consult; nothing is queued.
 *
 * No user-facing path enables outside help here (the Mac dashboard card is
 * C5; the public CLI command is C8). Until one exists every job binds
 * outside help off and this orchestrator is never triggered.
 */
import {
  consultWriterContextFromPack,
  evaluateConsultRequest,
  CONSULT_GATE_MAX_RECENT_CONSULTS,
} from '../../core/consult-gate.ts';
import {
  consultGateOptionsFromSettings,
  recheckConsultJobPolicy,
  type ConsultJobPolicy,
  type ConsultSettingsRead,
} from '../../core/consult-settings.ts';
import type { ZkapiConsultSettings } from '../../core/zkapi-consult-settings.ts';
import type {
  ZkapiConsultTransportOptions,
  ZkapiOpenControl,
  ZkapiOpenSessionResult,
} from '../../core/consult-transport-zkapi.ts';
import type { ConsultWriterInput, ConsultWriterOutcome } from '../../core/consult-writer.ts';
import { checkPrivateEvidence, type PrivateEvidenceGuard } from './private-answer-contract.ts';
import type { PrivateAnswerJobs } from './private-answer-jobs.ts';

/** Dispatch only within this long of first delivery (design §A.5.6). */
export const CONSULT_DISPATCH_WINDOW_MS = 5 * 60_000;
/** A collection by the claiming key within this long counts as recent panel activity (§A.5.6). */
export const CONSULT_RECENT_ACTIVITY_MS = 75_000;
/** Delivery room past the completion timeout that must remain in the follow-up window (§A.5.6). */
export const CONSULT_DELIVERY_MARGIN_MS = 2 * 60_000;
/** The writer's deadline (§A.3); its process is killed at it. */
export const CONSULT_WRITER_DEADLINE_MS = 60_000;
/** The transport's default completion timeout when the route states none (zkapi settings `timeoutMs`). */
export const CONSULT_DEFAULT_COMPLETION_TIMEOUT_MS = 6 * 60_000;

/** The one-line, content-free record of a consult's outcome. */
export type ConsultOrchestratorOutcome =
  | 'not_triggered'
  | 'appended'
  | 'writer_skipped'
  | 'writer_killed'
  | 'writer_failed'
  | 'writer_declined'
  | 'gate_refused'
  | 'ineligible'
  | 'transport_unavailable'
  | 'authorization_refused'
  | 'reply_failed'
  | 'append_refused'
  | 'error';

export type ConsultJobsSeam = Pick<
  PrivateAnswerJobs,
  'outsideSeam' | 'consultSnapshot' | 'dropConsultSnapshot' | 'markOutside' | 'appendOutsideBlock' | 'takeConsultLatch'
>;

export interface ConsultOrchestratorOptions {
  readonly jobs: ConsultJobsSeam;
  /** The writer (consult-writer.ts runConsultWriter, bound to its server and the memory probe); `kill` aborts on a fresh answer. */
  readonly writer: (input: ConsultWriterInput, control: { kill: AbortSignal; deadlineMs: number }) => Promise<ConsultWriterOutcome>;
  /** Opens the transport session (openZkapiConsultSession bound to the configured route); a failure means no consult. */
  readonly openSession: (control: ZkapiOpenControl) => Promise<ZkapiOpenSessionResult>;
  /** The settings now (readConsultSettings), re-read at the gate and inside final authorization. */
  readonly settings: () => ConsultSettingsRead;
  /** The live eligibility guard over the items the answer read (E1 before the writer, E2 inside authorization). */
  readonly eligible: PrivateEvidenceGuard;
  /** The configured completion timeout of the route (the deadline rule's input); default CONSULT_DEFAULT_COMPLETION_TIMEOUT_MS. */
  readonly completionTimeoutMs?: () => number;
  readonly now?: () => number;
  /** Content-free: codes, counts and milliseconds. */
  readonly log?: (line: string) => void;
  readonly writerDeadlineMs?: number;
}

export interface ConsultOrchestrator {
  /** The jobs engine's first-delivery hook. */
  onFirstDelivered(jobId: string): void;
  /** The jobs engine's answer-activity hook: kills a writer in flight. */
  onFreshAnswer(): void;
  /** Consults in flight (scheduled and not yet ended). */
  readonly inFlight: number;
  /** Resolves once every consult in flight has ended (tests). */
  idle(): Promise<void>;
  /** The texts of recently sent sub-questions, for the gate's repeat check (in memory only). */
  readonly recentQuestions: readonly string[];
}

interface Trigger {
  readonly rev: number;
  readonly policy: ConsultJobPolicy;
  readonly firstDeliveredAt: number;
  readonly followUntil: number;
}

export function createConsultOrchestrator(options: ConsultOrchestratorOptions): ConsultOrchestrator {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const completionTimeoutMs = () => {
    try {
      const value = options.completionTimeoutMs?.();
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : CONSULT_DEFAULT_COMPLETION_TIMEOUT_MS;
    } catch {
      return CONSULT_DEFAULT_COMPLETION_TIMEOUT_MS;
    }
  };
  const writerDeadlineMs = options.writerDeadlineMs ?? CONSULT_WRITER_DEADLINE_MS;
  const recent: string[] = [];
  const inFlight = new Map<string, Promise<void>>();
  /** Aborted by onFreshAnswer; replaced for the next writer. */
  let fresh = new AbortController();

  const record = (jobId: string, outcome: ConsultOrchestratorOutcome, startedAt: number, code?: string) => {
    void jobId;
    try {
      log(`[consult] outcome=${outcome}${code ? ` code=${code}` : ''} ms=${Math.max(0, now() - startedAt)}`);
    } catch {
      // Logging never fails a consult.
    }
  };

  /** Ends the job's consult: the block reads idle, the snapshot is gone, nothing triggers it again. */
  const fail = (jobId: string) => {
    options.jobs.dropConsultSnapshot(jobId);
    const seam = options.jobs.outsideSeam(jobId);
    if (!seam) return;
    options.jobs.markOutside(jobId, seam.rev, 'failed');
  };

  /** The dispatch window with delivery room (§A.5.6): now ≤ first + 5 min and now + timeout + 2 min ≤ followUntil. */
  const windowOpen = (trigger: Trigger, at: number, extraMs = 0): boolean =>
    at <= trigger.firstDeliveredAt + CONSULT_DISPATCH_WINDOW_MS
    && at + extraMs + completionTimeoutMs() + CONSULT_DELIVERY_MARGIN_MS <= trigger.followUntil;

  const recentlyActive = (lastCollectedAt: number | undefined, at: number): boolean =>
    lastCollectedAt !== undefined && at - lastCollectedAt <= CONSULT_RECENT_ACTIVITY_MS;

  /** The trigger (§A.2): every condition read from the server's own state, or undefined. */
  const trigger = (jobId: string): Trigger | undefined => {
    const seam = options.jobs.outsideSeam(jobId);
    if (!seam) return undefined;
    if (!seam.policy.outsideHelp || seam.panelCapability !== 2) return undefined;
    if (seam.state !== 'answer' || seam.outside !== 'idle') return undefined;
    if (seam.firstDeliveredAt === undefined || seam.followUntil === undefined) return undefined;
    const at = now();
    if (!recentlyActive(seam.lastCollectedAt, at)) return undefined;
    const snapshot = options.jobs.consultSnapshot(jobId);
    if (!snapshot) return undefined;
    // Consult only when the first answer is marked insufficient or has gaps,
    // and never for "these items do not answer" (owner ruling).
    if (snapshot.verdict.noAnswer) return undefined;
    if (snapshot.verdict.sufficient !== false && snapshot.gaps.length === 0) return undefined;
    const candidate: Trigger = { rev: seam.rev, policy: seam.policy, firstDeliveredAt: seam.firstDeliveredAt, followUntil: seam.followUntil };
    // Never start work that cannot dispatch with delivery room left.
    if (!windowOpen(candidate, at, writerDeadlineMs)) return undefined;
    return candidate;
  };

  const run = async (jobId: string, scheduled: Trigger): Promise<void> => {
    const startedAt = now();
    const snapshot = options.jobs.consultSnapshot(jobId);
    if (!snapshot) {
      fail(jobId);
      record(jobId, 'error', startedAt, 'snapshot_gone');
      return;
    }
    // E1: every item the answer read must still be eligible before the writer sees anything.
    if (!(await checkPrivateEvidence(options.eligible, snapshot.items)).every(Boolean)) {
      fail(jobId);
      record(jobId, 'ineligible', startedAt, 'e1');
      return;
    }
    // The writer and the transport warm-up overlap (§A.8, speed measure 2).
    // The session's own open deadline is the dispatch window's remainder.
    const sessionAbort = new AbortController();
    const openDeadlineMs = Math.max(1_000, scheduled.firstDeliveredAt + CONSULT_DISPATCH_WINDOW_MS - now());
    const opening = options.openSession({ signal: sessionAbort.signal, deadlineMs: openDeadlineMs });
    opening.catch(() => undefined);
    const kill = fresh.signal;
    const closeSession = async () => {
      sessionAbort.abort();
      const opened = await opening.catch(() => undefined);
      if (opened?.ok) opened.session.cancel();
    };
    let written: ConsultWriterOutcome;
    try {
      written = await options.writer(
        { question: snapshot.question, answer: snapshot.answer, gaps: snapshot.gaps },
        { kill, deadlineMs: writerDeadlineMs },
      );
    } catch {
      written = { kind: 'failed', reason: 'request_failed' };
    }
    if (written.kind !== 'questions') {
      await closeSession();
      fail(jobId);
      record(
        jobId,
        written.kind === 'skipped' ? 'writer_skipped' : written.kind === 'killed' ? 'writer_killed' : written.kind === 'declined' ? 'writer_declined' : 'writer_failed',
        startedAt,
        'reason' in written ? written.reason : undefined,
      );
      return;
    }
    // The gate (§A.4): the evidence as the pack, plus the question, answer
    // and gaps exactly as the writer saw them; languages and packs from the
    // settings now. A refusal is silent: the verdict never leaves the machine.
    const settingsAtGate = options.settings();
    const policyNow = recheckConsultJobPolicy(scheduled.policy, settingsAtGate);
    if (!policyNow.ok) {
      await closeSession();
      fail(jobId);
      record(jobId, 'authorization_refused', startedAt, policyNow.reason);
      return;
    }
    const verdict = evaluateConsultRequest(
      written.questions,
      consultWriterContextFromPack(snapshot.pack, { writerVisibleTexts: [snapshot.question, snapshot.answer, ...snapshot.gaps] }),
      {},
      { recentApprovedQuestions: [...recent] },
      consultGateOptionsFromSettings(settingsAtGate.settings),
    );
    if (verdict.decision !== 'pass') {
      await closeSession();
      fail(jobId);
      record(jobId, 'gate_refused', startedAt, String(verdict.reasons.length));
      return;
    }
    const opened = await opening.catch(() => undefined);
    if (!opened || !opened.ok) {
      fail(jobId);
      record(jobId, 'transport_unavailable', startedAt, opened?.ok === false ? opened.error.code : 'open_threw');
      return;
    }
    const session = opened.session;
    const questionText = written.questions.join('\n');
    const sendDeadlineMs = Math.max(1, scheduled.firstDeliveredAt + CONSULT_DISPATCH_WINDOW_MS - now());
    let authorized = false;
    const authorize = async (): Promise<boolean> => {
      const at = now();
      // Final authorization (§A.8 step 2): the settings revision, panel
      // activity, the window and delivery room, the job's state, eligibility
      // (E2), then the latch, synchronously last.
      if (!recheckConsultJobPolicy(scheduled.policy, options.settings()).ok) return false;
      const seam = options.jobs.outsideSeam(jobId);
      if (!seam || seam.state !== 'answer' || seam.outside !== 'pending' || seam.panelCapability !== 2) return false;
      if (!recentlyActive(seam.lastCollectedAt, at)) return false;
      if (!windowOpen(scheduled, at)) return false;
      if (!(await checkPrivateEvidence(options.eligible, snapshot.items)).every(Boolean)) return false;
      if (!options.jobs.takeConsultLatch(jobId)) return false;
      authorized = true;
      return true;
    };
    // The snapshot's work is done once the dispatch decision is made.
    const dispatched = session.send(questionText, { authorize, deadlineMs: sendDeadlineMs });
    dispatched.catch(() => undefined);
    const reply = await dispatched.catch(() => undefined);
    options.jobs.dropConsultSnapshot(jobId);
    if (!authorized) {
      fail(jobId);
      record(jobId, 'authorization_refused', startedAt, reply && reply.kind === 'failed' ? reply.error.code : undefined);
      return;
    }
    // Settlement, teardown and the lease release run on in the background.
    session.finished.then(
      (result) => {
        try {
          log(`[consult] finished=${result.ok ? 'ok' : result.error.code} ms=${Math.max(0, now() - startedAt)}`);
        } catch {
          // Logging never fails a consult.
        }
      },
      () => undefined,
    );
    if (!reply || reply.kind !== 'reply') {
      fail(jobId);
      record(jobId, 'reply_failed', startedAt, reply?.kind === 'failed' ? reply.error.code : 'no_reply');
      return;
    }
    const seam = options.jobs.outsideSeam(jobId);
    const appended = seam ? options.jobs.appendOutsideBlock(jobId, seam.rev, { text: reply.text, question: questionText, route: reply.routeLabel }) : undefined;
    if (!appended?.ok) {
      // A reply for a withdrawn, expired or evicted job is discarded (§A.5.4); the money is spent and the loss is stated.
      fail(jobId);
      record(jobId, 'append_refused', startedAt, appended ? appended.reason : 'job_gone');
      return;
    }
    for (const question of written.questions) {
      recent.push(question);
      while (recent.length > CONSULT_GATE_MAX_RECENT_CONSULTS) recent.shift();
    }
    record(jobId, 'appended', startedAt, `reply_ms=${reply.elapsedMs}`);
  };

  return {
    onFirstDelivered(jobId) {
      if (inFlight.has(jobId)) return;
      const scheduled = trigger(jobId);
      if (!scheduled) return;
      // The schedule mark, by compare-and-set on the revision read with the trigger.
      const marked = options.jobs.markOutside(jobId, scheduled.rev, 'pending');
      if (!marked.ok) return;
      const task = run(jobId, scheduled)
        .catch(() => {
          try {
            fail(jobId);
          } catch {
            // Nothing left to clean.
          }
          record(jobId, 'error', now(), 'threw');
        })
        .finally(() => {
          inFlight.delete(jobId);
        });
      inFlight.set(jobId, task);
    },
    onFreshAnswer() {
      // Kill a writer in flight; the next consult gets its own signal.
      const current = fresh;
      fresh = new AbortController();
      current.abort();
    },
    get inFlight() {
      return inFlight.size;
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    },
    get recentQuestions() {
      return [...recent];
    },
  };
}

/**
 * The transport options of the configured zkAPI consult route: exactly one
 * sovereignty model profile with `provider: 'zkapi'` and its settings, with
 * the daemon's inference key resolved from the profile's secret reference.
 * Undefined when there is no such route (or more than one), which the
 * orchestrator treats as "transport unavailable": no consult.
 */
export function resolveZkapiConsultTransport(
  profiles: Readonly<Record<string, { provider: string; baseUrl?: string; secretRef?: string; model?: string; zkapi?: ZkapiConsultSettings }>>,
  resolveSecret: (secretRef: string | undefined) => string | undefined,
  extra: Pick<ZkapiConsultTransportOptions, 'env' | 'statePath'> = {},
): ZkapiConsultTransportOptions | undefined {
  const routes = Object.values(profiles).filter((profile) => profile.provider === 'zkapi' && profile.zkapi && profile.baseUrl);
  if (routes.length !== 1) return undefined;
  const route = routes[0]!;
  let apiKey: string | undefined;
  try {
    apiKey = resolveSecret(route.secretRef);
  } catch {
    apiKey = undefined;
  }
  return {
    baseUrl: route.baseUrl!,
    model: route.model ?? '',
    ...(apiKey ? { apiKey } : {}),
    settings: route.zkapi!,
    ...(extra.env ? { env: extra.env } : {}),
    ...(extra.statePath ? { statePath: extra.statePath } : {}),
  };
}
