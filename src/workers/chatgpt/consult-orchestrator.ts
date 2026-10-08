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
 *     route available (profile and key) and no answer activity now
 *                                                           no → failed
 *     E1: every item the answer read still eligible; the fresh-answer
 *       generation captured before E1 still current         no → failed, snapshot dropped
 *     ┌ open the transport session (warm: lease, Tor, daemon, policy)   ┐ in parallel
 *     └ writer on its own server (memory rule, token bound, deadline)   ┘
 *       over ONE bounded input (question, answer, gaps), also the gate's
 *       writerVisibleTexts (question) and writerAnswerTexts (answer, gaps)
 *     gate over the snapshot pack + that bounded input      refuse → failed, silently
 *     session ready? busy or any failure → failed (never queued)
 *     send(question, authorize): E2 eligibility awaited FIRST, then
 *       synchronously: settings revision, state, panel activity, window and
 *       delivery room, the send-once latch; the questions enter the repeat
 *       history at that instant (dispatched or possibly dispatched)
 *     reply → eligibility over the retained identities once more →
 *       appendOutsideBlock (fitted; question and route label)
 *     finished runs on in the background; the snapshot is dropped at the
 *       dispatch decision (only item identities are held past it).
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
 * Inert unless a valid, enabled `~/.olympus/consult.json` exists: every job
 * then binds outside help off and nothing here runs. No product path writes
 * that file until C5 (the Mac dashboard card); the public CLI command is C8.
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
  type ConsultLevel,
  type ConsultSettingsRead,
} from '../../core/consult-settings.ts';
import type { ZkapiConsultSettings } from '../../core/zkapi-consult-settings.ts';
import type {
  ZkapiConsultTransportOptions,
  ZkapiOpenControl,
  ZkapiOpenSessionResult,
} from '../../core/consult-transport-zkapi.ts';
import { boundConsultWriterInput, type ConsultWriterInput, type ConsultWriterOutcome } from '../../core/consult-writer.ts';
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
  | 'superseded'
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
  /**
   * The writer (consult-writer.ts runConsultWriter, bound to its server and
   * the memory probe); `kill` aborts on a fresh answer; `level` is the job's
   * bound level, which selects the writer's rules.
   */
  readonly writer: (input: ConsultWriterInput, control: { kill: AbortSignal; deadlineMs: number; level: ConsultLevel }) => Promise<ConsultWriterOutcome>;
  /** Opens the transport session (openZkapiConsultSession bound to the configured route); a failure means no consult. */
  readonly openSession: (control: ZkapiOpenControl) => Promise<ZkapiOpenSessionResult>;
  /** Whether a route exists now (profile and inference key present); checked before any writer work. Default: assumed available. */
  readonly transportAvailable?: () => boolean;
  /** Whether a private answer is in flight now (the worker's answer activity); the writer never starts beside one. Default: not busy. */
  readonly answerActivityBusy?: () => boolean;
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

  const safe = (read: (() => boolean) | undefined, fallback: boolean): boolean => {
    try {
      return read ? read() : fallback;
    } catch {
      return !fallback;
    }
  };

  const run = async (jobId: string, scheduled: Trigger): Promise<void> => {
    const startedAt = now();
    // Nothing starts without a route to send on, or beside a private answer in flight.
    if (!safe(options.transportAvailable, true)) {
      fail(jobId);
      record(jobId, 'transport_unavailable', startedAt, 'no_route');
      return;
    }
    if (safe(options.answerActivityBusy, false)) {
      fail(jobId);
      record(jobId, 'superseded', startedAt, 'answer_busy');
      return;
    }
    // The fresh-answer generation is captured before E1: any answer that
    // starts while E1 is awaited supersedes this consult.
    const kill = fresh.signal;
    const first = options.jobs.consultSnapshot(jobId);
    if (!first) {
      fail(jobId);
      record(jobId, 'error', startedAt, 'snapshot_gone');
      return;
    }
    // Item identities (no text) are all that is held past the dispatch decision.
    const items = first.items;
    // E1: every item the answer read must still be eligible before the writer sees anything.
    if (!(await checkPrivateEvidence(options.eligible, items)).every(Boolean)) {
      fail(jobId);
      record(jobId, 'ineligible', startedAt, 'e1');
      return;
    }
    if (kill.aborted) {
      fail(jobId);
      record(jobId, 'superseded', startedAt, 'fresh_answer');
      return;
    }
    // The snapshot is re-read at every use: a withdrawal or the retention
    // clock ending the job's snapshot ends this consult too.
    const held = options.jobs.consultSnapshot(jobId);
    if (held !== first) {
      fail(jobId);
      record(jobId, 'error', startedAt, 'snapshot_gone');
      return;
    }
    // Re-checked immediately before the writer starts: a source answer can
    // begin during E1 through the worker's answer activity without the
    // consult hook, and the writer never runs beside one.
    if (safe(options.answerActivityBusy, false)) {
      fail(jobId);
      record(jobId, 'superseded', startedAt, 'answer_busy');
      return;
    }
    // One bounded input (§A.3): what the writer sees is exactly what the gate compares against.
    const bounded = boundConsultWriterInput({ question: held.question, answer: held.answer, gaps: held.gaps });
    // The writer and the transport warm-up overlap (§A.8, speed measure 2).
    // The session's own open deadline is the dispatch window's remainder.
    const sessionAbort = new AbortController();
    const openDeadlineMs = Math.max(1_000, scheduled.firstDeliveredAt + CONSULT_DISPATCH_WINDOW_MS - now());
    const opening = options.openSession({ signal: sessionAbort.signal, deadlineMs: openDeadlineMs });
    opening.catch(() => undefined);
    const closeSession = async () => {
      sessionAbort.abort();
      const opened = await opening.catch(() => undefined);
      if (opened?.ok) opened.session.cancel();
    };
    let written: ConsultWriterOutcome;
    try {
      written = await options.writer(bounded, { kill, deadlineMs: writerDeadlineMs, level: scheduled.policy.level });
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
    // settings now, and the level the job bound (the recheck below has just
    // confirmed the file still holds it). A refusal is silent: the verdict
    // never leaves the machine.
    const settingsAtGate = options.settings();
    const policyNow = recheckConsultJobPolicy(scheduled.policy, settingsAtGate);
    if (!policyNow.ok) {
      await closeSession();
      fail(jobId);
      record(jobId, 'authorization_refused', startedAt, policyNow.reason);
      return;
    }
    const current = options.jobs.consultSnapshot(jobId);
    if (current !== first) {
      await closeSession();
      fail(jobId);
      record(jobId, 'error', startedAt, 'snapshot_gone');
      return;
    }
    const verdict = evaluateConsultRequest(
      written.questions,
      // The owner's question, then the answer and its gaps: compared alike,
      // except that the unnamed level does not treat restating the answer's
      // situation as copying (consult-gate.ts, writerAnswerTexts).
      consultWriterContextFromPack(current.pack, { writerVisibleTexts: [bounded.question], writerAnswerTexts: [bounded.answer, ...bounded.gaps] }),
      {},
      { recentApprovedQuestions: [...recent] },
      { ...consultGateOptionsFromSettings(settingsAtGate.settings), level: scheduled.policy.level },
    );
    if (verdict.decision !== 'pass') {
      await closeSession();
      fail(jobId);
      // Reason codes are a closed enum and carry no question text.
      record(jobId, 'gate_refused', startedAt, [...verdict.reasons].sort().join(','));
      return;
    }
    const opened = await opening.catch(() => undefined);
    if (!opened || !opened.ok) {
      fail(jobId);
      record(jobId, 'transport_unavailable', startedAt, opened?.ok === false ? opened.error.code : 'open_threw');
      return;
    }
    const session = opened.session;
    const questions = written.questions;
    const questionText = questions.join('\n');
    const sendDeadlineMs = Math.max(1, scheduled.firstDeliveredAt + CONSULT_DISPATCH_WINDOW_MS - now());
    let authorized = false;
    const authorize = async (signal: AbortSignal): Promise<boolean> => {
      // Final authorization (§A.8 step 2). The one await, E2 eligibility,
      // runs first; everything that can go stale during it is read
      // synchronously after it, and the latch is taken last in the same
      // turn, so nothing changes between these reads and the reservation.
      if (!(await checkPrivateEvidence(options.eligible, items)).every(Boolean)) return false;
      if (signal.aborted) return false;
      if (!recheckConsultJobPolicy(scheduled.policy, options.settings()).ok) return false;
      const seam = options.jobs.outsideSeam(jobId);
      if (!seam || seam.state !== 'answer' || seam.outside !== 'pending' || seam.panelCapability !== 2) return false;
      const at = now();
      if (!recentlyActive(seam.lastCollectedAt, at)) return false;
      if (!windowOpen(scheduled, at)) return false;
      if (!options.jobs.takeConsultLatch(jobId)) return false;
      authorized = true;
      // Dispatched, or possibly dispatched, from here: the repeat check sees these questions whatever happens next.
      for (const question of questions) {
        recent.push(question);
        while (recent.length > CONSULT_GATE_MAX_RECENT_CONSULTS) recent.shift();
      }
      return true;
    };
    // The dispatch decision: the snapshot's work is done. The job's snapshot
    // is dropped now, before the send is awaited; only the item identities
    // (`items`) are retained, for E2 and the reply-time check.
    options.jobs.dropConsultSnapshot(jobId);
    const dispatched = session.send(questionText, { authorize, deadlineMs: sendDeadlineMs });
    dispatched.catch(() => undefined);
    const reply = await dispatched.catch(() => undefined);
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
    // Reply-time eligibility: an item the answer read that is no longer
    // eligible when the reply arrives keeps the block off the panel.
    if (!(await checkPrivateEvidence(options.eligible, items)).every(Boolean)) {
      fail(jobId);
      record(jobId, 'ineligible', startedAt, 'reply');
      return;
    }
    const seam = options.jobs.outsideSeam(jobId);
    const appended = seam ? options.jobs.appendOutsideBlock(jobId, seam.rev, { text: reply.text, question: questionText, route: reply.routeLabel, level: scheduled.policy.level }) : undefined;
    if (!appended?.ok) {
      // A reply for a withdrawn, expired or evicted job is discarded (§A.5.4); the money is spent and the loss is stated.
      fail(jobId);
      record(jobId, 'append_refused', startedAt, appended ? appended.reason : 'job_gone');
      return;
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
