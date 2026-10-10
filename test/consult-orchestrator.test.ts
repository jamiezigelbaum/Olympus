// The consult orchestrator (src/workers/chatgpt/consult-orchestrator.ts;
// design docs/design/frontier-consult-lane.md §A.2, §A.3, §A.5.6, §A.7,
// §A.8; stage C4b) on the real jobs engine, with a fake model, a fake writer
// and a fake transport session. Nothing here starts a process, reads a
// settings file or touches a network: the settings are in-memory reads and
// the transport is a recorder. Includes the design's B5 cases (no dispatch
// for old panels, stale settings, expired windows or a set latch, each x10)
// and the precompute-reuse snapshot test.

import { describe, expect, test } from 'bun:test';
import { privateEvidencePack } from '../src/core/analyst-built-in.ts';
import { consultWriterContextFromPack, evaluateConsultRequest } from '../src/core/consult-gate.ts';
import { DEFAULT_CONSULT_SETTINGS, bindConsultJobPolicy, consultGateOptionsFromSettings, recheckConsultJobPolicy, type ConsultJobPolicy, type ConsultSettingsRead } from '../src/core/consult-settings.ts';
import type { ZkapiConsultReply, ZkapiConsultSession, ZkapiOpenControl, ZkapiOpenSessionResult, ZkapiSendControl } from '../src/core/consult-transport-zkapi.ts';
import type { ConsultWriterInput, ConsultWriterOutcome } from '../src/core/consult-writer.ts';
import {
  CONSULT_DISPATCH_WINDOW_MS,
  CONSULT_RECENT_ACTIVITY_MS,
  createConsultOrchestrator,
  resolveZkapiConsultTransport,
  type ConsultOrchestrator,
} from '../src/workers/chatgpt/consult-orchestrator.ts';
import type { PrivateAnswerEnvelopeV1, PrivateAnswerModel, PrivateAnswerModelResult } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PRIVATE_ANSWER_CONSULT_SNAPSHOT_MS, PrivateAnswerJobs, type ClaimResponse } from '../src/workers/chatgpt/private-answer-jobs.ts';

const INSTALL = 'f'.repeat(32);
const QUESTION = 'When does my lease end?';
const ANSWER = 'Your lease ends in May.';
const GAPS = ['The deposit terms are not stated.'];
const EVIDENCE = [{ title: 'Lease', trust_domain: 'secure_local', chunks: ['The lease for the flat ends in May and the landlord holds the deposit.'] }];
const PACK = privateEvidencePack(QUESTION, [{ id: 'lease-1', title: 'Lease', text: EVIDENCE[0]!.chunks[0]! }]);
const CLEAN_QUESTION = 'How are rental deposit disputes usually resolved between tenants and landlords?';
const COPIED_QUESTION = 'Does the lease for the flat ends in May and the landlord holds the deposit?';
// Refused at both levels: it copies four words of the question ChatGPT sent
// (a copy of the documents alone may go out at the unnamed level).
const OWNER_COPY_QUESTION = 'When does my lease end in practice?';
const OUTSIDE_TEXT = 'Deposit disputes are usually settled through a scheme or a small claims process.';

const SETTINGS_ON: ConsultSettingsRead = { state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, revision: 7, enabled: true } };
// The owner's own writer as consult.json names it (harness `ownWriter: true`).
const OWN_WRITER = Object.freeze({ baseUrl: 'http://192.168.1.20:8090/v1', model: 'home/model', timeoutMs: 180_000 });
const withOwnWriter = (read: ConsultSettingsRead): ConsultSettingsRead => (read.state === 'valid' ? { ...read, settings: { ...read.settings, writer: OWN_WRITER } } : read);
const ON: ConsultJobPolicy = bindConsultJobPolicy(SETTINGS_ON);
const OFF: ConsultJobPolicy = bindConsultJobPolicy({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });

type Verdict = { sufficient: boolean | undefined; noAnswer: boolean };

/** The fake model: its pack is built from the evidence it is handed, and the snapshot metadata only when asked for (`consult`). */
function model(verdict: Verdict | 'none' = { sufficient: false, noAnswer: false }, calls = { n: 0, asked: [] as boolean[] }): PrivateAnswerModel {
  return {
    status: () => ({ state: 'ready' }),
    answerPrivately: async (question, evidence, _signal, _observe, options): Promise<PrivateAnswerModelResult> => {
      calls.n += 1;
      calls.asked.push(options?.consult === true);
      const pack = privateEvidencePack(question, evidence.map((item, index) => ({ id: `item-${index + 1}`, text: (item.chunks as string[])[0] ?? '' })));
      return {
        answer: ANSWER,
        citations: [{ title: 'Lease', source: 'Dropbox' }],
        unanswered: [...GAPS],
        ...(verdict === 'none' || !options?.consult ? {} : { consult: { verdict, pack } }),
      };
    },
  };
}

interface FakeSession {
  sends: Array<{ question: string; control: ZkapiSendControl }>;
  cancelled: number;
  authorizeResults: boolean[];
  session: ZkapiConsultSession;
}

interface Harness {
  jobs: PrivateAnswerJobs;
  orchestrator: ConsultOrchestrator;
  clock: { now: number };
  settings: { read: ConsultSettingsRead };
  eligible: { refuse: boolean; hold?: (() => Promise<void>) | undefined };
  route: { available: boolean };
  activity: { busy: boolean };
  writer: { calls: ConsultWriterInput[]; deadlines: number[]; levels: string[]; choices: Array<unknown>; kills: AbortSignal[]; outcome: ConsultWriterOutcome; hold?: () => Promise<void>; releases: Array<() => void>; holdAll: () => void; releaseAll: () => void };
  transport: { opens: ZkapiOpenControl[]; result: 'ok' | 'busy'; sessions: FakeSession[]; beforeAuthorize?: () => Promise<void>; onReply?: () => void; reply: 'reply' | 'failed' };
  logs: string[];
  calls: { n: number; asked: boolean[] };
}

function harness(options: {
  policy?: ConsultJobPolicy;
  verdict?: Verdict | 'none';
  writerOutcome?: ConsultWriterOutcome;
  followUpWindowMs?: number;
  completionTimeoutMs?: number;
  settings?: ConsultSettingsRead;
  ownWriter?: boolean;
  writerDeadlineMs?: () => number;
} = {}): Harness {
  const clock = { now: 1_000_000 };
  // `ownWriter: true` names the own writer in the file and in the bound policy.
  const settings = { read: options.ownWriter ? withOwnWriter(options.settings ?? SETTINGS_ON) : options.settings ?? SETTINGS_ON };
  const policy = options.policy
    ? (options.ownWriter ? { ...options.policy, writer: OWN_WRITER } : options.policy)
    : (options.ownWriter ? bindConsultJobPolicy(settings.read) : ON);
  const eligible: Harness['eligible'] = { refuse: false };
  const route = { available: true };
  const activity = { busy: false };
  const logs: string[] = [];
  const calls = { n: 0, asked: [] as boolean[] };
  const writer: Harness['writer'] = {
    calls: [],
    deadlines: [],
    levels: [],
    choices: [],
    kills: [],
    outcome: options.writerOutcome ?? { kind: 'questions', questions: [CLEAN_QUESTION], promptTokens: 900, ms: 10 },
    releases: [],
    /** Every writer call waits until releaseAll(). */
    holdAll() {
      writer.hold = () => new Promise<void>((resolve) => {
        writer.releases.push(resolve);
      });
    },
    releaseAll() {
      for (const release of writer.releases.splice(0)) release();
    },
  };
  const transport: Harness['transport'] = { opens: [], result: 'ok', sessions: [], reply: 'reply' };
  let orchestrator!: ConsultOrchestrator;
  const jobs = new PrivateAnswerJobs({
    eligible: async (items) => items.map(() => !eligible.refuse),
    model: () => model(options.verdict, calls),
    installId: () => INSTALL,
    now: () => clock.now,
    log: () => {},
    audit: () => {},
    claimHoldMs: 0,
    consultPolicy: () => policy,
    ...(options.followUpWindowMs !== undefined ? { followUpWindowMs: options.followUpWindowMs } : {}),
    onFirstDelivered: (jobId) => orchestrator.onFirstDelivered(jobId),
    onAnswerActivity: () => orchestrator.onFreshAnswer(),
  });
  orchestrator = createConsultOrchestrator({
    jobs,
    eligible: async (items) => {
      if (eligible.hold) await eligible.hold();
      return items.map(() => !eligible.refuse);
    },
    transportAvailable: () => route.available,
    answerActivityBusy: () => activity.busy,
    settings: () => settings.read,
    now: () => clock.now,
    log: (line) => logs.push(line),
    completionTimeoutMs: () => options.completionTimeoutMs ?? 6 * 60_000,
    ...(options.writerDeadlineMs ? { writerDeadlineMs: options.writerDeadlineMs } : {}),
    writer: async (input, control) => {
      writer.calls.push(input);
      writer.deadlines.push(control.deadlineMs);
      writer.levels.push(control.level);
      writer.choices.push(control.writer);
      writer.kills.push(control.kill);
      if (writer.hold) await writer.hold();
      if (control.kill.aborted) return { kind: 'killed', reason: 'fresh_answer' };
      return writer.outcome;
    },
    openSession: async (control): Promise<ZkapiOpenSessionResult> => {
      transport.opens.push(control);
      if (transport.result === 'busy') {
        return { ok: false, error: { code: 'busy', message: 'Another consult is running.', outcome: 'not_sent', networkIdentity: 'not_verified' } };
      }
      const fake: FakeSession = { sends: [], cancelled: 0, authorizeResults: [], session: undefined as unknown as ZkapiConsultSession };
      let state: ZkapiConsultSession['state'] = 'ready';
      let finish!: (value: Awaited<ZkapiConsultSession['finished']>) => void;
      const finished = new Promise<Awaited<ZkapiConsultSession['finished']>>((resolve) => {
        finish = resolve;
      });
      fake.session = {
        get state() {
          return state;
        },
        async send(question, sendControl = {}): Promise<ZkapiConsultReply> {
          fake.sends.push({ question, control: sendControl });
          state = 'authorizing';
          if (transport.beforeAuthorize) await transport.beforeAuthorize();
          const ok = sendControl.authorize ? await sendControl.authorize(new AbortController().signal) : true;
          fake.authorizeResults.push(ok);
          if (!ok) {
            state = 'cancelled';
            const error = { code: 'authorization_refused' as const, message: 'refused', outcome: 'not_sent' as const, networkIdentity: 'not_verified' as const };
            finish({ ok: false, error });
            return { kind: 'failed', error };
          }
          state = 'dispatched';
          if (transport.reply === 'failed') {
            const error = { code: 'daemon_error' as const, message: 'failed', outcome: 'sent_failed' as const, networkIdentity: 'hidden' as const };
            finish({ ok: false, error });
            return { kind: 'failed', error };
          }
          state = 'replied';
          transport.onReply?.();
          const receipt = {} as ZkapiConsultReply extends { receipt: infer R } ? R : never;
          queueMicrotask(() => finish({ ok: true, text: OUTSIDE_TEXT, routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt: receipt as never, elapsedMs: 5 }));
          return { kind: 'reply', text: OUTSIDE_TEXT, routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt: receipt as never, elapsedMs: 5 };
        },
        cancel() {
          fake.cancelled += 1;
          if (state === 'ready' || state === 'authorizing') state = 'cancelled';
        },
        finished,
      };
      transport.sessions.push(fake);
      return { ok: true, session: fake.session };
    },
  });
  return { jobs, orchestrator, clock, settings, eligible, route, activity, writer, transport, logs, calls };
}

async function settled(jobs: PrivateAnswerJobs, ms = 10_000): Promise<void> {
  const live = (jobs as unknown as { jobs: Map<string, { claimKey?: string; outcome?: unknown }> }).jobs;
  const quiet = () => jobs.pendingAnalyses === 0 && [...live.values()].every((job) => job.claimKey === undefined || job.outcome !== undefined);
  const deadline = Date.now() + ms;
  while (!quiet()) {
    if (Date.now() > deadline) throw new Error('private answer jobs did not settle');
    await Bun.sleep(2);
  }
  await Bun.sleep(0);
}

function begin(h: Harness, question = QUESTION): string {
  return h.jobs.begin({ question, count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, caller: question }).jobId!;
}

/** Claims and waits for first delivery; returns the first envelope response. */
async function deliver(h: Harness, jobId: string, panel: Awaited<ReturnType<typeof generatePanelKeyPair>>, cap: 1 | 2 = 2): Promise<ClaimResponse> {
  const first = await h.jobs.claim(jobId, panel.publicKey, cap);
  expect(first.status).toBe(202);
  await settled(h.jobs);
  return h.jobs.claim(jobId, panel.publicKey, cap);
}

async function envelope(jobId: string, panel: Awaited<ReturnType<typeof generatePanelKeyPair>>, response: ClaimResponse): Promise<PrivateAnswerEnvelopeV1> {
  expect(response.status).toBe(200);
  return JSON.parse(await openPrivateAnswer(jobId, panel.privateKey, response.body as unknown as SealedPrivateAnswer)) as PrivateAnswerEnvelopeV1;
}

/** One full consult: begin, deliver (the trigger), wait for the orchestrator. */
async function consult(h: Harness, cap: 1 | 2 = 2) {
  const jobId = begin(h);
  const panel = await generatePanelKeyPair();
  const first = await deliver(h, jobId, panel, cap);
  await h.orchestrator.idle();
  return { jobId, panel, first };
}

describe('the gate fixtures behave as the tests assume', () => {
  test('the clean question passes and the copied one is refused against the snapshot pack', () => {
    const context = consultWriterContextFromPack(PACK, { writerVisibleTexts: [QUESTION, ANSWER, ...GAPS] });
    expect(evaluateConsultRequest([CLEAN_QUESTION], context, {}, {}, { languages: ['en'] })).toEqual({ decision: 'pass', reasons: [] });
    expect(evaluateConsultRequest([COPIED_QUESTION], context, {}, {}, { languages: ['en'] }).decision).toBe('refuse');
    for (const level of ['general', 'unnamed'] as const) {
      expect(evaluateConsultRequest([OWNER_COPY_QUESTION], context, {}, {}, { languages: ['en'], level, askedQuestionTexts: [QUESTION] }).reasons).toContain('owner_question_copy');
    }
  });

  test('the implied-place case (M0 round 2): "Portugal" with countries and places on, absent from or present in the snapshot, and with both packs off; unit words pass', () => {
    const texts = (place: string) => ['What should I prepare for the trip?', `Your itinerary covers three days in ${place} with a morning flight and a hotel near the river.`, 'The documents do not say what the trip requires.'];
    const lisbon = privateEvidencePack('What should I prepare for the trip?', [
      { id: 'itinerary', text: 'Three days in Lisbon: the flight lands in the morning and the hotel is near the river.' },
    ]);
    const portugalPack = privateEvidencePack('What should I prepare for the trip?', [
      { id: 'itinerary', text: 'Three days in Portugal: the flight lands in the morning and the hotel is near the river.' },
    ]);
    const absent = consultWriterContextFromPack(lisbon, { writerVisibleTexts: texts('Lisbon') });
    const present = consultWriterContextFromPack(portugalPack, { writerVisibleTexts: texts('Portugal') });
    const defaults = consultGateOptionsFromSettings(DEFAULT_CONSULT_SETTINGS);
    expect(defaults.domains).toMatchObject({ countries: true, places: true, technical: true });
    const question = ['What entry rules apply to visitors arriving in Portugal?'];
    // Countries are admitted by default (owner decision 2026-10-07): an implied
    // country the documents never write passes; one they do write is refused by
    // the snapshot name rule; with the countries and places packs off the
    // vocabulary refuses it.
    expect(evaluateConsultRequest(question, absent, {}, {}, defaults)).toEqual({ decision: 'pass', reasons: [] });
    const held = evaluateConsultRequest(question, present, {}, {}, defaults);
    expect(held.decision).toBe('refuse');
    expect(held.reasons).toContain('snapshot_name');
    expect(held.reasons).not.toContain('unknown_word');
    const off = evaluateConsultRequest(question, absent, {}, {}, { ...defaults, domains: { ...defaults.domains, countries: false, places: false } });
    expect(off.decision).toBe('refuse');
    expect(off.reasons).toContain('unknown_word');
    const context = absent;
    expect(evaluateConsultRequest(['What passport validity do most countries require from visitors?'], context, {}, {}, defaults)).toEqual({ decision: 'pass', reasons: [] });
    // The temperature scale names (C4b review round 1 found them refused) are
    // in the olympus-terms pack since 2026-10-07, capitalised or not.
    for (const question of ['How are Celsius and Fahrenheit readings converted in practice?', 'How are celsius and fahrenheit readings converted in practice?']) {
      expect({ question, verdict: evaluateConsultRequest([question], context, {}, {}, defaults) }).toEqual({ question, verdict: { decision: 'pass', reasons: [] } });
    }
    expect(evaluateConsultRequest(['How are temperature scales usually converted in practice?'], context, {}, {}, defaults)).toEqual({ decision: 'pass', reasons: [] });
  });
});

describe('trigger and the full path', () => {
  test('after first delivery an insufficient answer with gaps schedules one consult: pending, writer, gate, warm session, authorized send, appended block', async () => {
    const h = harness();
    const { jobId, panel, first } = await consult(h);
    // The first envelope was sealed before the trigger ran (first delivery is
    // the first `ready` actually returned), so it reads idle at revision 1.
    const initial = await envelope(jobId, panel, first);
    expect(initial.outside).toEqual({ state: 'idle' });
    expect(initial.rev).toBe(1);
    // The writer saw the question, the answer and the gaps only.
    expect(h.writer.calls).toEqual([{ question: QUESTION, answer: ANSWER, gaps: GAPS }]);
    // Under the level the job bound (a new setup's default).
    expect(h.writer.levels).toEqual(['unnamed']);
    // The session opened with a cancel signal and a deadline while the writer ran, and sent once with final authorization.
    expect(h.transport.opens.length).toBe(1);
    expect(h.transport.opens[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(h.transport.opens[0]!.deadlineMs).toBeGreaterThan(0);
    const session = h.transport.sessions[0]!;
    expect(session.sends.map((send) => send.question)).toEqual([CLEAN_QUESTION]);
    expect(session.sends[0]!.control.deadlineMs).toBeGreaterThan(0);
    expect(session.authorizeResults).toEqual([true]);
    expect(session.cancelled).toBe(0);
    // The block is appended, fitted, with the question and the route label; the next envelope carries it.
    const next = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(next.outside).toEqual({ state: 'appended', text: OUTSIDE_TEXT, question: CLEAN_QUESTION, route: 'zkAPI via Tor', level: 'unnamed' });
    expect(next.answer).toBe(ANSWER);
    expect(next.unanswered).toEqual(GAPS);
    // The snapshot is gone, the question is remembered for the repeat check, and the log carries codes only.
    expect(h.jobs.consultSnapshot(jobId)).toBeUndefined();
    expect(h.orchestrator.recentQuestions).toEqual([CLEAN_QUESTION]);
    expect(h.logs.some((line) => line.startsWith('[consult] outcome=appended'))).toBe(true);
    for (const line of h.logs) {
      expect(line).not.toContain(CLEAN_QUESTION);
      expect(line).not.toContain(OUTSIDE_TEXT);
      expect(line).not.toContain(ANSWER);
    }
  });


  test('the bound level selects the writer\'s rules and labels the block; a level change before the gate refuses as stale', async () => {
    const general: ConsultSettingsRead = { state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, revision: 7, enabled: true, level: 'general' } };
    const h = harness({ policy: bindConsultJobPolicy(general), settings: general });
    const { jobId, panel } = await consult(h);
    expect(h.writer.levels).toEqual(['general']);
    const next = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(next.outside).toMatchObject({ state: 'appended', question: CLEAN_QUESTION, level: 'general' });

    // Bound "general", then the file says "unnamed" at the same revision: no send.
    const changed = harness({ policy: bindConsultJobPolicy(general), settings: { state: 'valid', settings: { ...general.settings, level: 'unnamed' } } });
    await consult(changed);
    expect(changed.transport.sessions.flatMap((session) => session.sends)).toEqual([]);
    expect(changed.logs.some((line) => line.includes('outcome=authorization_refused code=settings_stale'))).toBe(true);
  });
  test('negative triggers: outside help off, an old panel, a sufficient answer without gaps, "these items do not answer", or no verdict metadata start nothing', async () => {
    for (const [label, h, cap] of [
      ['off', harness({ policy: OFF }), 2],
      ['old panel', harness(), 1],
      ['sufficient', harness({ verdict: { sufficient: true, noAnswer: false } }), 2],
      ['no answer', harness({ verdict: { sufficient: false, noAnswer: true } }), 2],
      ['no metadata', harness({ verdict: 'none' }), 2],
    ] as const) {
      const sufficientModel = label === 'sufficient';
      // A sufficient answer carries no gaps (cleanUnanswered drops them); the fake model always lists one, so strip it here.
      if (sufficientModel) {
        (h.jobs as unknown as { options: { model: () => PrivateAnswerModel } }).options.model = () => ({
          status: () => ({ state: 'ready' }),
          answerPrivately: async () => ({ answer: ANSWER, citations: [], unanswered: [], consult: { verdict: { sufficient: true, noAnswer: false }, pack: PACK } }),
        });
      }
      await consult(h, cap);
      expect({ label, writers: h.writer.calls.length, opens: h.transport.opens.length }).toEqual({ label, writers: 0, opens: 0 });
    }
  });

  test('a sufficient answer that still lists gaps consults (gaps count); an unmarked answer with gaps consults too', async () => {
    const withGaps = harness({ verdict: { sufficient: true, noAnswer: false } });
    await consult(withGaps);
    expect(withGaps.writer.calls.length).toBe(1);
    const unmarked = harness({ verdict: { sufficient: undefined, noAnswer: false } });
    await consult(unmarked);
    expect(unmarked.writer.calls.length).toBe(1);
  });

  test('no delivery room: a follow-up window that cannot hold the writer, the completion timeout and the margin starts nothing', async () => {
    // 6 min timeout + 2 min margin + 60 s writer = 9 min; an 8-minute window is too short.
    const h = harness({ followUpWindowMs: 8 * 60_000 });
    const { jobId, panel, first } = await consult(h);
    expect(h.writer.calls.length).toBe(0);
    expect(h.transport.opens.length).toBe(0);
    expect((await envelope(jobId, panel, first)).outside).toEqual({ state: 'idle' });
    const roomy = harness({ followUpWindowMs: 10 * 60_000 });
    await consult(roomy);
    expect(roomy.writer.calls.length).toBe(1);
  });
});

describe('the snapshot', () => {
  test('is deep-frozen, the same object on every read, holds exactly the pack, question, answer, gaps, verdict and item identities, and is dropped five minutes after first delivery', async () => {
    const h = harness();
    // Hold the writer so the snapshot can be inspected while the consult is pending.
    h.writer.holdAll();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await deliver(h, jobId, panel);
    const snapshot = h.jobs.consultSnapshot(jobId)!;
    expect(snapshot).toBeDefined();
    expect(h.jobs.consultSnapshot(jobId)).toBe(snapshot);
    expect(snapshot.question).toBe(QUESTION);
    expect(snapshot.answer).toBe(ANSWER);
    expect(snapshot.gaps).toEqual(GAPS);
    expect(snapshot.verdict).toEqual({ sufficient: false, noAnswer: false });
    expect(snapshot.pack.candidates[0]!.chunks).toEqual(PACK.candidates[0]!.chunks);
    expect(Object.keys(snapshot).sort()).toEqual(['answer', 'gaps', 'items', 'pack', 'question', 'verdict']);
    // Items are identities only: no title or chunk text.
    expect(JSON.stringify(snapshot.items)).not.toContain('Lease');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pack)).toBe(true);
    expect(Object.isFrozen(snapshot.pack.candidates[0]!.chunks)).toBe(true);
    expect(() => {
      (snapshot as { question: string }).question = 'changed';
    }).toThrow();
    expect(() => {
      (snapshot.pack.candidates[0]!.chunks as string[]).push('x');
    }).toThrow();
    // Retention: at most five minutes after first delivery, whatever the orchestrator does.
    h.clock.now += PRIVATE_ANSWER_CONSULT_SNAPSHOT_MS - 1;
    expect(h.jobs.consultSnapshot(jobId)).toBe(snapshot);
    h.clock.now += 1;
    expect(h.jobs.consultSnapshot(jobId)).toBeUndefined();
    h.writer.releaseAll();
    await h.orchestrator.idle();
  });

  test('precompute reuse: two searches with the identical question share one analysis, and each job\'s snapshot carries that search-time pack', async () => {
    const h = harness();
    h.writer.holdAll();
    const a = begin(h);
    const b = h.jobs.begin({ question: QUESTION, count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, caller: 'other' }).jobId!;
    const panelA = await generatePanelKeyPair();
    const panelB = await generatePanelKeyPair();
    await deliver(h, a, panelA);
    await deliver(h, b, panelB);
    expect(h.calls.n).toBe(1);
    const snapA = h.jobs.consultSnapshot(a)!;
    const snapB = h.jobs.consultSnapshot(b)!;
    expect(snapA).toBeDefined();
    expect(snapB).toBeDefined();
    expect(snapA).not.toBe(snapB);
    // The same search-time pack feeds both: each job holds its own frozen clone of it (the shared analysis keeps the model's object by reference).
    expect(snapA.pack).not.toBe(snapB.pack);
    expect(snapA.pack).toEqual(snapB.pack);
    expect(Object.isFrozen(snapA.pack) && Object.isFrozen(snapB.pack)).toBe(true);
    h.writer.releaseAll();
    await h.orchestrator.idle();
  });

  test('E1: an item the answer read that is no longer eligible before the writer runs ends the consult with the snapshot dropped and no writer call', async () => {
    const h = harness();
    // Deliver first (the guard must vouch at delivery), then revoke before the orchestrator's E1 check.
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    h.writer.hold = async () => {};
    // Make the orchestrator see a refusal at E1 by refusing from the first-delivery hook onwards.
    const first = await h.jobs.claim(jobId, panel.publicKey, 2);
    expect(first.status).toBe(202);
    await settled(h.jobs);
    const before = h.eligible.refuse;
    const original = h.orchestrator.onFirstDelivered.bind(h.orchestrator);
    (h.jobs as unknown as { options: { onFirstDelivered: (id: string) => void } }).options.onFirstDelivered = (id) => {
      h.eligible.refuse = true;
      original(id);
    };
    await h.jobs.claim(jobId, panel.publicKey, 2);
    await h.orchestrator.idle();
    h.eligible.refuse = before;
    expect(h.writer.calls.length).toBe(0);
    expect(h.jobs.consultSnapshot(jobId)).toBeUndefined();
    expect(h.logs.some((line) => line.includes('outcome=ineligible'))).toBe(true);
  });
});

describe('writer outcomes and the gate', () => {
  test('a gate refusal is silent: the session is cancelled, nothing is sent, the block reads idle and the log carries no text', async () => {
    const h = harness({ writerOutcome: { kind: 'questions', questions: [OWNER_COPY_QUESTION], promptTokens: 900, ms: 10 } });
    const { jobId, panel } = await consult(h);
    expect(h.transport.sessions[0]!.sends).toEqual([]);
    expect(h.transport.sessions[0]!.cancelled).toBe(1);
    expect(h.transport.opens[0]!.signal!.aborted).toBe(true);
    expect((await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
    expect(h.logs.some((line) => /^\[consult\] outcome=gate_refused code=[a-z_]+(,[a-z_]+)* ms=\d+$/.test(line))).toBe(true);
    for (const line of h.logs) expect(line).not.toContain('lease');
    expect(h.orchestrator.recentQuestions).toEqual([]);
  });

  test('the question ChatGPT sent reaches the gate apart from the snapshot: a place in it may go out at the unnamed level, one not in it (or past the writer\'s cut) may not', async () => {
    const evidence = [{ title: 'Letter of intent', trust_domain: 'secure_local', chunks: ['The buyer will sign the deed before the notary in Catalonia.'] }];
    const asked = 'Who usually pays the notary fees in Catalonia?';
    const run = async (ownerQuestion: string) => {
      const h = harness({ writerOutcome: { kind: 'questions', questions: [asked], promptTokens: 900, ms: 10 } });
      const jobId = h.jobs.begin({ question: ownerQuestion, count: 1, evidence, refresh: async () => evidence, caller: ownerQuestion }).jobId!;
      await deliver(h, jobId, await generatePanelKeyPair());
      await h.orchestrator.idle();
      return h;
    };
    const typed = await run('How are notary fees usually split between buyer and seller in Catalonia?');
    expect(typed.writer.levels).toEqual(['unnamed']);
    expect(typed.transport.sessions[0]!.sends.map((send) => send.question)).toEqual([asked]);
    const untyped = await run('How are notary fees usually split between buyer and seller?');
    expect(untyped.transport.sessions[0]!.sends).toEqual([]);
    expect(untyped.logs.some((line) => line.includes('outcome=gate_refused code=snapshot_name'))).toBe(true);
    // Past the writer's 1,000-character cut, the place is not exempt; the copy check still reads it.
    const long = await run(`${'Please answer carefully. '.repeat(45)}How are notary fees split in Catalonia?`);
    expect(long.writer.calls[0]!.question).not.toContain('Catalonia');
    expect(long.transport.sessions[0]!.sends).toEqual([]);
    expect(long.logs.some((line) => line.includes('outcome=gate_refused code=snapshot_name'))).toBe(true);
  });

  test('a skipped, declined, killed or failed writer ends the consult without a send', async () => {
    for (const outcome of [
      { kind: 'skipped', reason: 'memory_low' },
      { kind: 'skipped', reason: 'prompt_too_long' },
      { kind: 'declined', promptTokens: 100, ms: 5 },
      { kind: 'killed', reason: 'deadline' },
      { kind: 'skipped', reason: 'prompt_tokens_unavailable' },
      { kind: 'failed', reason: 'form' },
    ] as const satisfies readonly ConsultWriterOutcome[]) {
      const h = harness({ writerOutcome: outcome });
      const { jobId, panel } = await consult(h);
      expect({ outcome, sends: h.transport.sessions[0]?.sends ?? [], cancelled: h.transport.sessions[0]?.cancelled }).toEqual({ outcome, sends: [], cancelled: 1 });
      expect((await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
      expect(h.jobs.consultSnapshot(jobId)).toBeUndefined();
    }
  });

  test('a fresh private answer while the writer runs kills it: the consult ends with the block idle', async () => {
    const h = harness();
    h.writer.holdAll();
    const { jobId, panel } = await (async () => {
      const id = begin(h);
      const key = await generatePanelKeyPair();
      await deliver(h, id, key);
      return { jobId: id, panel: key };
    })();
    expect(h.writer.calls.length).toBe(1);
    expect(h.writer.kills[0]!.aborted).toBe(false);
    // Another search arrives: its analysis starts, which is answer activity.
    begin(h, 'What does the garden bylaw say?');
    expect(h.writer.kills[0]!.aborted).toBe(true);
    h.writer.releaseAll();
    await h.orchestrator.idle();
    await settled(h.jobs);
    expect(h.transport.sessions[0]!.sends).toEqual([]);
    expect((await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
    expect(h.logs.some((line) => line.includes('outcome=writer_killed code=fresh_answer'))).toBe(true);
  });
});

describe('transport and dispatch', () => {
  test('a busy transport skips the consult and never queues it', async () => {
    const h = harness();
    h.transport.result = 'busy';
    const { jobId, panel } = await consult(h);
    expect(h.transport.opens.length).toBe(1);
    expect(h.transport.sessions.length).toBe(0);
    expect((await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
    expect(h.logs.some((line) => line.includes('outcome=transport_unavailable code=busy'))).toBe(true);
  });

  test('a failed completion marks the consult failed: the block reads idle and the panel shows nothing more', async () => {
    const h = harness();
    h.transport.reply = 'failed';
    const { jobId, panel } = await consult(h);
    expect(h.transport.sessions[0]!.authorizeResults).toEqual([true]);
    expect((await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
    expect(h.logs.some((line) => line.includes('outcome=reply_failed code=daemon_error'))).toBe(true);
    // Dispatched: the question stays in the repeat history whatever came back.
    expect(h.orchestrator.recentQuestions).toEqual([CLEAN_QUESTION]);
  });

  test('the latch: one consult per job; a second trigger is a no-op and the latch cannot be taken twice', async () => {
    const h = harness();
    const { jobId } = await consult(h);
    h.orchestrator.onFirstDelivered(jobId);
    await h.orchestrator.idle();
    expect(h.writer.calls.length).toBe(1);
    expect(h.transport.sessions.length).toBe(1);
    expect(h.jobs.takeConsultLatch(jobId)).toBe(false);
  });

  test('final authorization refuses when the panel has not collected within 75 s, or the dispatch window has passed', async () => {
    for (const advance of [CONSULT_RECENT_ACTIVITY_MS + 1, CONSULT_DISPATCH_WINDOW_MS + 1]) {
      const h = harness();
      h.transport.beforeAuthorize = async () => {
        h.clock.now += advance;
      };
      const { jobId, panel } = await consult(h);
      expect(h.transport.sessions[0]!.authorizeResults).toEqual([false]);
      expect(h.logs.some((line) => line.includes('outcome=authorization_refused'))).toBe(true);
      // The block never stays pending once its consult is over.
      expect((await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
    }
  });

  test('final authorization re-checks eligibility (E2): a revoked item refuses the dispatch', async () => {
    const h = harness();
    h.transport.beforeAuthorize = async () => {
      h.eligible.refuse = true;
    };
    await consult(h);
    expect(h.transport.sessions[0]!.authorizeResults).toEqual([false]);
  });
});

describe('B5: no dispatch for old panels, stale settings, expired windows or a set latch (each x10)', () => {
  test('stale settings: a revision change between the trigger and the send refuses inside final authorization, nothing dispatched', async () => {
    for (let round = 0; round < 10; round += 1) {
      const h = harness();
      h.transport.beforeAuthorize = async () => {
        h.settings.read = { state: 'valid', settings: { ...SETTINGS_ON.settings, revision: 8 } };
      };
      await consult(h);
      expect(h.transport.sessions[0]!.authorizeResults).toEqual([false]);
      expect(h.orchestrator.recentQuestions).toEqual([]);
    }
  });

  test('settings turned off, or the file gone, between the writer and the gate: no session is used and nothing is sent', async () => {
    for (let round = 0; round < 10; round += 1) {
      const h = harness();
      h.writer.holdAll();
      const jobId = begin(h);
      const panel = await generatePanelKeyPair();
      await deliver(h, jobId, panel);
      h.settings.read = round % 2 === 0
        ? { state: 'valid', settings: { ...SETTINGS_ON.settings, enabled: false } }
        : { state: 'absent', settings: DEFAULT_CONSULT_SETTINGS };
      h.writer.releaseAll();
      await h.orchestrator.idle();
      expect(h.transport.sessions[0]!.sends).toEqual([]);
      expect(h.transport.sessions[0]!.cancelled).toBe(1);
    }
  });

  test('old panels: capability 1 never dispatches', async () => {
    for (let round = 0; round < 10; round += 1) {
      const h = harness();
      await consult(h, 1);
      expect(h.transport.opens.length).toBe(0);
    }
  });

  test('expired window: a clock past the dispatch window at authorization never dispatches', async () => {
    for (let round = 0; round < 10; round += 1) {
      const h = harness();
      h.transport.beforeAuthorize = async () => {
        h.clock.now += CONSULT_DISPATCH_WINDOW_MS + 1;
      };
      await consult(h);
      expect(h.transport.sessions[0]!.authorizeResults).toEqual([false]);
    }
  });

  test('a set latch: a latch taken before final authorization refuses the dispatch', async () => {
    for (let round = 0; round < 10; round += 1) {
      const h = harness();
      let jobId: string | undefined;
      h.transport.beforeAuthorize = async () => {
        expect(h.jobs.takeConsultLatch(jobId!)).toBe(true);
      };
      const id = begin(h);
      jobId = id;
      const panel = await generatePanelKeyPair();
      await deliver(h, id, panel);
      await h.orchestrator.idle();
      expect(h.transport.sessions[0]!.authorizeResults).toEqual([false]);
    }
  });
});

describe('round-1 review cases', () => {
  test('the writer sees one bounded input (question cut at 1,000 characters), and the model is asked for the snapshot only on a job that bound outside help on', async () => {
    const h = harness();
    const longQuestion = `${QUESTION} ${'x'.repeat(2_000)}`;
    const jobId = begin(h, longQuestion);
    const panel = await generatePanelKeyPair();
    await deliver(h, jobId, panel);
    await h.orchestrator.idle();
    expect(h.writer.calls[0]!.question.length).toBe(1_000);
    expect(h.calls.asked).toEqual([true]);
    const off = harness({ policy: OFF });
    await consult(off);
    expect(off.calls.asked).toEqual([false]);
  });

  test('no route (profile or key missing) or a private answer in flight: no writer work at all', async () => {
    const noRoute = harness();
    noRoute.route.available = false;
    const { jobId, panel } = await consult(noRoute);
    expect(noRoute.writer.calls.length).toBe(0);
    expect(noRoute.transport.opens.length).toBe(0);
    expect((await envelope(jobId, panel, await noRoute.jobs.claim(jobId, panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
    expect(noRoute.logs.some((line) => line.includes('outcome=transport_unavailable code=no_route'))).toBe(true);
    const busy = harness();
    busy.activity.busy = true;
    await consult(busy);
    expect(busy.writer.calls.length).toBe(0);
    expect(busy.logs.some((line) => line.includes('outcome=superseded code=answer_busy'))).toBe(true);
  });

  test('a fresh answer during E1 supersedes the consult before the writer starts', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    const first = await h.jobs.claim(jobId, panel.publicKey, 2);
    expect(first.status).toBe(202);
    await settled(h.jobs);
    // Hold only the orchestrator's E1 call: the guard is read synchronously
    // when the trigger runs, so the hold is set around that call alone.
    let releaseE1!: () => void;
    const e1 = new Promise<void>((resolve) => {
      releaseE1 = resolve;
    });
    (h.jobs as unknown as { options: { onFirstDelivered: (id: string) => void } }).options.onFirstDelivered = (id) => {
      h.eligible.hold = () => e1;
      h.orchestrator.onFirstDelivered(id);
      h.eligible.hold = undefined;
    };
    await h.jobs.claim(jobId, panel.publicKey, 2);
    // A fresh answer arrives while E1 is awaited.
    h.orchestrator.onFreshAnswer();
    releaseE1();
    await h.orchestrator.idle();
    expect(h.writer.calls.length).toBe(0);
    expect(h.logs.some((line) => line.includes('outcome=superseded code=fresh_answer'))).toBe(true);
  });

  test('deferred E2: outside help turned off while eligibility is awaited inside final authorization refuses; no latch, no send', async () => {
    for (let round = 0; round < 10; round += 1) {
      const h = harness();
      let holdE2 = false;
      h.eligible.hold = async () => {
        if (!holdE2) return;
        holdE2 = false;
        // The flip lands during the await.
        h.settings.read = { state: 'valid', settings: { ...SETTINGS_ON.settings, enabled: false } };
      };
      h.transport.beforeAuthorize = async () => {
        holdE2 = true;
      };
      const { jobId } = await consult(h);
      expect(h.transport.sessions[0]!.authorizeResults).toEqual([false]);
      expect(h.jobs.takeConsultLatch(jobId)).toBe(false);
      expect(h.orchestrator.recentQuestions).toEqual([]);
    }
  });

  test('a changed claim-time evidence set discards the precompute: the snapshot is the recomputed baseline\'s pack', async () => {
    const h = harness();
    h.writer.holdAll();
    const changed = [{ title: 'Lease v2', trust_domain: 'secure_local', chunks: ['SENTINEL_CHANGED: the renewed lease ends in June and the deposit is held in a scheme.'], sourceItem: { provider: 'p', localItemId: 'lease-v2' } }];
    const jobId = h.jobs.begin({ question: QUESTION, count: 1, evidence: [{ ...EVIDENCE[0]!, sourceItem: { provider: 'p', localItemId: 'lease-v1' } }], refresh: async () => changed, caller: 'c' }).jobId!;
    const panel = await generatePanelKeyPair();
    await deliver(h, jobId, panel);
    expect(h.calls.n).toBe(2);
    const snapshot = h.jobs.consultSnapshot(jobId)!;
    expect(snapshot.pack.candidates.map((candidate) => candidate.chunks[0])).toEqual([changed[0]!.chunks[0]]);
    expect(JSON.stringify(snapshot.pack)).not.toContain('landlord holds the deposit');
    h.writer.releaseAll();
    await h.orchestrator.idle();
  });

  test('the snapshot expiring while the writer runs ends the consult before the gate: nothing is sent', async () => {
    const h = harness();
    h.writer.holdAll();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await deliver(h, jobId, panel);
    expect(h.writer.calls.length).toBe(1);
    h.clock.now += PRIVATE_ANSWER_CONSULT_SNAPSHOT_MS;
    h.writer.releaseAll();
    await h.orchestrator.idle();
    expect(h.transport.sessions[0]!.sends).toEqual([]);
    expect(h.transport.sessions[0]!.cancelled).toBe(1);
    expect(h.logs.some((line) => line.includes('outcome=error code=snapshot_gone'))).toBe(true);
  });

  test('a dispatched question whose completion fails is still in the repeat history', async () => {
    const h = harness();
    h.transport.reply = 'failed';
    await consult(h);
    expect(h.transport.sessions[0]!.authorizeResults).toEqual([true]);
    expect(h.orchestrator.recentQuestions).toEqual([CLEAN_QUESTION]);
  });
});

describe('round-2 review cases', () => {
  test('a private answer that starts during E1 (without the consult hook) stops the writer from starting', async () => {
    const h = harness();
    let armed = false;
    h.eligible.hold = async () => {
      if (!armed) return;
      armed = false;
      h.activity.busy = true;
    };
    (h.jobs as unknown as { options: { onFirstDelivered: (id: string) => void } }).options.onFirstDelivered = (id) => {
      armed = true;
      h.orchestrator.onFirstDelivered(id);
    };
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await deliver(h, jobId, panel);
    await h.orchestrator.idle();
    expect(h.writer.calls.length).toBe(0);
    expect(h.logs.some((line) => line.includes('outcome=superseded code=answer_busy'))).toBe(true);
  });

  test('the job\'s snapshot is gone before the send is awaited; identities alone carry E2 and the reply-time check', async () => {
    const h = harness();
    let snapshotAtSend: unknown = 'unread';
    let jobIdSeen: string | undefined;
    h.transport.beforeAuthorize = async () => {
      snapshotAtSend = h.jobs.consultSnapshot(jobIdSeen!);
    };
    const jobId = begin(h);
    jobIdSeen = jobId;
    const panel = await generatePanelKeyPair();
    await deliver(h, jobId, panel);
    await h.orchestrator.idle();
    expect(snapshotAtSend).toBeUndefined();
    expect(h.transport.sessions[0]!.authorizeResults).toEqual([true]);
    expect((await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).outside.state).toBe('appended');
  });

  test('reply-time eligibility: an item revoked after dispatch keeps the reply off the panel', async () => {
    const h = harness();
    // Revoked after authorization, as the reply is handed over.
    h.transport.onReply = () => {
      h.eligible.refuse = true;
    };
    const { jobId, panel } = await consult(h);
    expect(h.transport.sessions[0]!.authorizeResults).toEqual([true]);
    expect(h.logs.some((line) => line.includes('outcome=ineligible code=reply'))).toBe(true);
    // The withdrawal the guard now forces is told inside the envelope; the block itself was never appended.
    h.eligible.refuse = false;
    const next = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(next.outside).toEqual({ state: 'idle' });
    expect(h.orchestrator.recentQuestions).toEqual([CLEAN_QUESTION]);
  });

  test('mixed-policy sharing: an outside-help-off job sharing the analysis gets today\'s bytes, and the metadata it never needs is neither cloned nor frozen on the shared path', async () => {
    let policy = ON;
    const h = harness();
    (h.jobs as unknown as { options: { consultPolicy: () => ConsultJobPolicy } }).options.consultPolicy = () => policy;
    h.writer.holdAll();
    const on = begin(h);
    policy = OFF;
    const off = h.jobs.begin({ question: QUESTION, count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, caller: 'other' }).jobId!;
    policy = ON;
    const panelOn = await generatePanelKeyPair();
    const panelOff = await generatePanelKeyPair();
    const offFirst = await deliver(h, off, panelOff);
    await deliver(h, on, panelOn);
    expect(h.calls.n).toBe(1);
    expect(h.calls.asked).toEqual([true]);
    // The off job: phase 1 bytes, bucket-padded, exactly as without the feature.
    expect(offFirst.status).toBe(200);
    const offPlain = await openPrivateAnswer(off, panelOff.privateKey, offFirst.body as unknown as SealedPrivateAnswer);
    expect(JSON.parse(offPlain)).toMatchObject({ v: 1, answer: ANSWER });
    expect(h.jobs.consultSnapshot(off)).toBeUndefined();
    // The shared analysis holds the model's object by reference: no clone, no freeze, on the shared completion path.
    const shared = (h.jobs as unknown as { shared: Map<string, { result?: { consult?: { pack: unknown } } }> }).shared;
    const analysis = [...shared.values()][0]!;
    expect(analysis.result?.consult).toBeDefined();
    expect(Object.isFrozen(analysis.result!.consult!.pack)).toBe(false);
    // The on job's snapshot is its own frozen clone of that pack.
    const snapshot = h.jobs.consultSnapshot(on)!;
    expect(snapshot.pack).not.toBe(analysis.result!.consult!.pack);
    expect(snapshot.pack).toEqual(analysis.result!.consult!.pack as typeof snapshot.pack);
    expect(Object.isFrozen(snapshot.pack)).toBe(true);
    h.writer.releaseAll();
    await h.orchestrator.idle();
  });
});

describe('the zkAPI route from the sovereignty profiles', () => {
  test('exactly one zkapi profile with settings and a base URL gives transport options with the resolved key; none or two give undefined', () => {
    const zkapi = { tor: 'required', timeoutMs: 360_000 } as unknown as NonNullable<Parameters<typeof resolveZkapiConsultTransport>[0][string]['zkapi']>;
    const one = resolveZkapiConsultTransport(
      { a: { provider: 'openai', baseUrl: 'https://x' }, z: { provider: 'zkapi', baseUrl: 'http://127.0.0.1:8787/v1', secretRef: 'env:K', model: 'openai/gpt-5-mini', zkapi } },
      (ref) => (ref === 'env:K' ? 'key' : undefined),
      { statePath: '/tmp/state.json' },
    );
    expect(one).toEqual({ baseUrl: 'http://127.0.0.1:8787/v1', model: 'openai/gpt-5-mini', apiKey: 'key', settings: zkapi, statePath: '/tmp/state.json' });
    expect(resolveZkapiConsultTransport({ a: { provider: 'openai' } }, () => undefined)).toBeUndefined();
    expect(resolveZkapiConsultTransport({ z: { provider: 'zkapi', baseUrl: 'http://127.0.0.1:8787/v1', zkapi }, y: { provider: 'zkapi', baseUrl: 'http://127.0.0.1:8788/v1', zkapi } }, () => undefined)).toBeUndefined();
    expect(resolveZkapiConsultTransport({ z: { provider: 'zkapi', baseUrl: 'http://127.0.0.1:8787/v1', zkapi } }, () => { throw new Error('no store'); })).toMatchObject({ baseUrl: 'http://127.0.0.1:8787/v1' });
  });
});

describe('the owner\'s own writer (owner decision 2026-10-10)', () => {
  test('it reads bounded evidence excerpts from the snapshot pack, with its own deadline; the built-in writer never sees evidence', async () => {
    const own = harness({ ownWriter: true });
    await consult(own);
    expect(own.writer.calls.length).toBe(1);
    const input = own.writer.calls[0]!;
    expect(input.question).toBe(QUESTION);
    expect(input.evidence?.length).toBeGreaterThan(0);
    expect(input.evidence!.join(' ')).toContain('The lease for the flat ends in May');
    expect(own.writer.deadlines).toEqual([180_000]);
    expect(own.writer.choices).toEqual([OWN_WRITER]);
    // The gate still compares against the whole pack and the send happens as before.
    expect(own.transport.sessions[0]!.sends.map((send) => send.question)).toEqual([CLEAN_QUESTION]);

    const builtIn = harness({ ownWriter: false });
    await consult(builtIn);
    expect(builtIn.writer.calls).toEqual([{ question: QUESTION, answer: ANSWER, gaps: GAPS }]);
    expect(builtIn.writer.deadlines).toEqual([60_000]);
    expect(builtIn.writer.choices).toEqual([null]);
  });

  test('"these items do not answer" still never escalates, with either writer (owner change 2026-10-10)', async () => {
    for (const ownWriter of [true, false]) {
      const h = harness({ ownWriter, verdict: { sufficient: false, noAnswer: true } });
      await consult(h);
      expect(h.writer.calls).toEqual([]);
      expect(h.transport.opens).toEqual([]);
    }
  });

  test('the own writer gets the thin net: a copied phrase goes out at Strict, where the built-in writer\'s full gate refuses it', async () => {
    const general: ConsultSettingsRead = { state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, revision: 7, enabled: true, level: 'general' } };
    const own = harness({ ownWriter: true, policy: bindConsultJobPolicy(general), settings: general, writerOutcome: { kind: 'questions', questions: [COPIED_QUESTION], promptTokens: 0, ms: 1 } });
    await consult(own);
    expect(own.writer.calls[0]!.evidence?.length).toBeGreaterThan(0);
    expect(own.transport.sessions[0]!.sends.map((send) => send.question)).toEqual([COPIED_QUESTION]);

    const builtIn = harness({ ownWriter: false, policy: bindConsultJobPolicy(general), settings: general, writerOutcome: { kind: 'questions', questions: [COPIED_QUESTION], promptTokens: 0, ms: 1 } });
    await consult(builtIn);
    expect(builtIn.transport.sessions.flatMap((session) => session.sends)).toEqual([]);
    expect(builtIn.logs.some((line) => line.startsWith('[consult] outcome=gate_refused'))).toBe(true);
  });

  test('the writer is bound once: a file that names another writer (or none, or cannot be read) by the gate refuses, nothing sent (review of PR #209)', async () => {
    for (const [label, change] of [
      ['own writer removed', (read: ConsultSettingsRead): ConsultSettingsRead => {
        const { writer: _removed, ...rest } = read.settings;
        return { state: 'valid', settings: rest };
      }],
      ['own writer changed', (read: ConsultSettingsRead): ConsultSettingsRead => ({ state: 'valid', settings: { ...read.settings, writer: { ...OWN_WRITER, model: 'other/model' } } })],
      ['file unreadable', (): ConsultSettingsRead => ({ state: 'invalid', reason: 'unreadable', settings: DEFAULT_CONSULT_SETTINGS })],
    ] as const) {
      const h = harness({ ownWriter: true, writerOutcome: { kind: 'questions', questions: [COPIED_QUESTION], promptTokens: 0, ms: 1 } });
      // Bound with the own writer; the file changes while the writer runs.
      h.writer.hold = async () => {
        h.settings.read = change(h.settings.read);
      };
      await consult(h);
      expect({ label, choices: h.writer.choices }).toEqual({ label, choices: [OWN_WRITER] });
      expect({ label, sends: h.transport.sessions.flatMap((session) => session.sends) }).toEqual({ label, sends: [] });
      expect({ label, refused: h.logs.some((line) => line.includes('outcome=authorization_refused')) }).toEqual({ label, refused: true });
    }
    // The reverse: bound to the built-in writer, a writer added later is not used and the job refuses.
    const builtIn = harness({ writerOutcome: { kind: 'questions', questions: [CLEAN_QUESTION], promptTokens: 0, ms: 1 } });
    builtIn.writer.hold = async () => {
      builtIn.settings.read = withOwnWriter(builtIn.settings.read);
    };
    await consult(builtIn);
    expect(builtIn.writer.choices).toEqual([null]);
    expect(builtIn.transport.sessions.flatMap((session) => session.sends)).toEqual([]);
  });

  test('final authorization compares the writer identity', () => {
    const bound = bindConsultJobPolicy(withOwnWriter(SETTINGS_ON));
    expect(bound.writer).toEqual(OWN_WRITER);
    expect(recheckConsultJobPolicy(bound, withOwnWriter(SETTINGS_ON))).toEqual({ ok: true });
    expect(recheckConsultJobPolicy(bound, SETTINGS_ON)).toEqual({ ok: false, reason: 'settings_stale' });
    expect(recheckConsultJobPolicy(ON, withOwnWriter(SETTINGS_ON))).toEqual({ ok: false, reason: 'settings_stale' });
    expect(recheckConsultJobPolicy(ON, SETTINGS_ON)).toEqual({ ok: true });
  });

  test('the zkAPI model for ChatGPT questions replaces the route\'s model only when set', () => {
    const profiles = { z: { provider: 'zkapi', baseUrl: 'http://127.0.0.1:8787/v1', model: 'openai/gpt-5-mini', zkapi: {} as never } };
    expect(resolveZkapiConsultTransport(profiles, () => undefined)?.model).toBe('openai/gpt-5-mini');
    expect(resolveZkapiConsultTransport(profiles, () => undefined, { chatgptFrontierModel: 'other/model' })?.model).toBe('other/model');
  });
});
