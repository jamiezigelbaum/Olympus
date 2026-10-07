/**
 * Stage C5 end-to-end acceptance (design docs/design/frontier-consult-lane.md
 * §A.14), with fakes where money or processes would be: the owner turns
 * outside help on through the Mac dashboard route (control session → worker →
 * adapter → settings writer → ~/.olympus/consult.json in a temp HOME); a
 * private answer with gaps is delivered to a capability-2 panel; the
 * orchestrator runs with a fake writer and a fake transport session; the
 * outside block appears in the next phase-2 envelope. Turned off, the same
 * path is inert: no writer call, no session, idle forever. A job created
 * while on and delivered after a turn-off refuses inside final authorization
 * (stale revision), so nothing is sent.
 *
 * No real llama-server, Tor or daemon is started; nothing is written under
 * the real HOME.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { privateEvidencePack } from '../src/core/analyst-built-in.ts';
import { bindConsultJobPolicy, readConsultSettings } from '../src/core/consult-settings.ts';
import type { ZkapiConsultReadiness, ZkapiConsultReply, ZkapiConsultSession, ZkapiOpenControl, ZkapiOpenSessionResult, ZkapiSendControl } from '../src/core/consult-transport-zkapi.ts';
import type { ConsultWriterInput, ConsultWriterOutcome } from '../src/core/consult-writer.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS, ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION } from '../src/core/zkapi-consult-settings.ts';
import { createConsultOrchestrator, type ConsultOrchestrator } from '../src/workers/chatgpt/consult-orchestrator.ts';
import type { PrivateAnswerEnvelopeV1, PrivateAnswerModel, PrivateAnswerModelResult } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, type ClaimResponse } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS } from '../src/workers/dashboard/outside-help.ts';
import { createDashboardConsultAdapter } from '../src/workers/email-source/dashboard-consult.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';

const ORIGIN = 'http://127.0.0.1:17777';
const INSTALL = 'f'.repeat(32);
const QUESTION = 'When does my lease end?';
const ANSWER = 'Your lease ends in May.';
const GAPS = ['The deposit terms are not stated.'];
const EVIDENCE = [{ title: 'Lease', trust_domain: 'secure_local', chunks: ['The lease for the flat ends in May and the landlord holds the deposit.'] }];
const CLEAN_QUESTION = 'How are rental deposit disputes usually resolved between tenants and landlords?';
const OUTSIDE_TEXT = 'Deposit disputes are usually settled through a scheme or a small claims process.';
const ALL_IDS = ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => entry.id);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'olympus-consult-accept-'));
  cleanups.push(() => {
    try {
      chmodSync(join(home, '.olympus'), 0o700);
    } catch {
      // nothing to repair
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function readiness(): ZkapiConsultReadiness {
  return {
    daemonExecutable: '/usr/local/bin/zkapi-clientd',
    daemonVersion: '0.1.6',
    torExecutable: '/usr/local/bin/tor',
    tor: 'per_consult',
    confinement: { level: 'non_loopback_blocked', limit: 'loopback allowed' },
    daemonPort: 'free',
    torPort: 'free',
    apiKeyConfigured: true,
    money: { acknowledgements: { complete: true, accepted: 8, required: 8 }, expiryEstimate: { state: 'active', fundingDate: '2026-10-01', expiryDate: '2026-10-31', daysLeft: 24, notice: 'none' }, depositAboveSuggestedCeiling: false },
    requestsToday: { count: 0 },
    spendToday: { reservedUsd: 0 },
    unresolvedSession: false,
    fences: [],
    routeLabel: 'payment privacy; route not verified',
    blockers: [],
  };
}

/** The Mac dashboard, with the real adapter over the temp HOME, behind the real HTTP boundary. */
function dashboard(home: string) {
  const env = { HOME: home, OLYMPUS_ZKAPI_API_KEY: 'zk-local-key' };
  mkdirSync(join(home, '.olympus'), { recursive: true, mode: 0o700 });
  const config = structuredClone(loadSovereigntyPreset('private-cloud-only')) as SovereigntyConfig;
  (config.modelProfiles as Record<string, unknown>)['zkapi-consult'] = {
    provider: 'zkapi',
    trust: 'standard_cloud',
    purpose: 'consult',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'openai/gpt-5-mini',
    secretRef: 'env:OLYMPUS_ZKAPI_API_KEY',
    zkapi: { fundingDate: '2026-10-01', acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ALL_IDS } },
  };
  const policyPath = join(home, '.olympus', 'sovereignty.json');
  writeFileSync(policyPath, JSON.stringify(config), { mode: 0o600 });
  const consult = createDashboardConsultAdapter({
    sovereignty: { config, source: 'file', path: policyPath },
    secretPresent: (ref) => ref === 'env:OLYMPUS_ZKAPI_API_KEY' && env.OLYMPUS_ZKAPI_API_KEY !== undefined,
    requestReload: () => true,
    env,
    statePath: join(home, '.olympus', 'zkapi-consult-state.json'),
    readiness: async () => readiness(),
    recoverSession: async () => { throw new Error('no recovery in this test'); },
  });
  const dir = mkdtempSync(join(tmpdir(), 'olympus-consult-accept-worker-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const worker = createEmailSourceWorker({ sourceDashboard: {
    sovereigntyEngine: createSovereigntyEngine(config),
    registryPath: join(dir, 'handles.json'),
    consult,
  } });
  cleanups.push(() => worker.close?.());
  const fetcher = withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: 'worker-secret' });
  return { env, fetcher };
}

/** The local-only mint: the one session grade the consult routes take (a loopback browser, no bearer). */
async function controlSession(fetcher: (request: Request) => Promise<Response>): Promise<Record<string, string>> {
  const request = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
  recordRequestPeer(request, '127.0.0.1');
  const mint = await fetcher(request);
  expect(mint.status).toBe(200);
  const csrf = ((await mint.json()) as { csrf_token: string }).csrf_token;
  return { Cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };
}

async function setOutsideHelp(fetcher: (request: Request) => Promise<Response>, custody: Record<string, string>, enabled: boolean, revision: number): Promise<number> {
  const response = await fetcher(new Request(`${ORIGIN}${DASHBOARD_OUTSIDE_HELP_PATHS.enable}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...custody },
    body: JSON.stringify({ enabled, revision, languages: ['en'] }),
  }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; revision: number };
  expect(body.ok).toBe(true);
  return body.revision;
}

// --- The engine side: the real jobs engine and orchestrator over the settings file, with fakes for the model, the writer and the transport.

function model(): PrivateAnswerModel {
  return {
    status: () => ({ state: 'ready' }),
    answerPrivately: async (question, evidence, _signal, _observe, options): Promise<PrivateAnswerModelResult> => {
      const pack = privateEvidencePack(question, evidence.map((item, index) => ({ id: `item-${index + 1}`, text: (item.chunks as string[])[0] ?? '' })));
      return {
        answer: ANSWER,
        citations: [{ title: 'Lease', source: 'Dropbox' }],
        unanswered: [...GAPS],
        ...(options?.consult ? { consult: { verdict: { sufficient: false, noAnswer: false }, pack } } : {}),
      };
    },
  };
}

interface Engine {
  jobs: PrivateAnswerJobs;
  orchestrator: ConsultOrchestrator;
  writerCalls: ConsultWriterInput[];
  opens: ZkapiOpenControl[];
  sends: Array<{ question: string; authorized: boolean }>;
  /** Runs inside the fake session's send, after the writer and the gate, immediately before the real final `authorize` callback. */
  beforeAuthorize?: () => Promise<void>;
  authorizeCalls: number;
  logs: string[];
}

function engine(env: Record<string, string | undefined>): Engine {
  const writerCalls: ConsultWriterInput[] = [];
  const opens: ZkapiOpenControl[] = [];
  const sends: Array<{ question: string; authorized: boolean }> = [];
  const logs: string[] = [];
  const result: Partial<Engine> = { authorizeCalls: 0 };
  let orchestrator!: ConsultOrchestrator;
  const jobs = new PrivateAnswerJobs({
    eligible: async (items) => items.map(() => true),
    model: () => model(),
    installId: () => INSTALL,
    log: () => {},
    audit: () => {},
    claimHoldMs: 0,
    // The production binding: the settings file, read at job creation.
    consultPolicy: () => bindConsultJobPolicy(readConsultSettings({ env })),
    onFirstDelivered: (jobId) => orchestrator.onFirstDelivered(jobId),
    onAnswerActivity: () => orchestrator.onFreshAnswer(),
  });
  orchestrator = createConsultOrchestrator({
    jobs,
    eligible: async (items) => items.map(() => true),
    transportAvailable: () => true,
    settings: () => readConsultSettings({ env }),
    log: (line) => logs.push(line),
    writer: async (input): Promise<ConsultWriterOutcome> => {
      writerCalls.push(input);
      return { kind: 'questions', questions: [CLEAN_QUESTION], promptTokens: 900, ms: 10 };
    },
    openSession: async (control): Promise<ZkapiOpenSessionResult> => {
      opens.push(control);
      let state: ZkapiConsultSession['state'] = 'ready';
      let finish!: (value: Awaited<ZkapiConsultSession['finished']>) => void;
      const finished = new Promise<Awaited<ZkapiConsultSession['finished']>>((resolve) => {
        finish = resolve;
      });
      const session: ZkapiConsultSession = {
        get state() {
          return state;
        },
        async send(question, sendControl: ZkapiSendControl = {}): Promise<ZkapiConsultReply> {
          state = 'authorizing';
          if (result.beforeAuthorize) await result.beforeAuthorize();
          result.authorizeCalls = (result.authorizeCalls ?? 0) + 1;
          const ok = sendControl.authorize ? await sendControl.authorize(new AbortController().signal) : true;
          sends.push({ question, authorized: ok });
          if (!ok) {
            state = 'cancelled';
            const error = { code: 'authorization_refused' as const, message: 'refused', outcome: 'not_sent' as const, networkIdentity: 'not_verified' as const };
            finish({ ok: false, error });
            return { kind: 'failed', error };
          }
          state = 'replied';
          const receipt = {} as never;
          queueMicrotask(() => finish({ ok: true, text: OUTSIDE_TEXT, routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt, elapsedMs: 5 }));
          return { kind: 'reply', text: OUTSIDE_TEXT, routeLabel: 'zkAPI via Tor', networkIdentity: 'hidden', receipt, elapsedMs: 5 };
        },
        cancel() {
          if (state === 'ready' || state === 'authorizing') state = 'cancelled';
        },
        finished,
      };
      return { ok: true, session };
    },
  });
  const engineResult = result as Engine;
  Object.assign(engineResult, { jobs, orchestrator, writerCalls, opens, sends, logs });
  return engineResult;
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

async function envelope(jobId: string, panel: Awaited<ReturnType<typeof generatePanelKeyPair>>, response: ClaimResponse): Promise<PrivateAnswerEnvelopeV1> {
  expect(response.status).toBe(200);
  return JSON.parse(await openPrivateAnswer(jobId, panel.privateKey, response.body as unknown as SealedPrivateAnswer)) as PrivateAnswerEnvelopeV1;
}

/** An envelope with no outside block: absent (a job bound off) or idle. */
function expectNoOutside(value: PrivateAnswerEnvelopeV1): void {
  expect(value.outside === undefined || value.outside.state === 'idle').toBe(true);
  expect(value.answer).toBe(ANSWER);
}

/** Begin a job, claim it as a capability-2 panel, wait for first delivery and the orchestrator. */
async function answer(e: Engine) {
  const jobId = e.jobs.begin({ question: QUESTION, count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, caller: QUESTION }).jobId!;
  const panel = await generatePanelKeyPair();
  const first = await e.jobs.claim(jobId, panel.publicKey, 2);
  expect(first.status).toBe(202);
  await settled(e.jobs);
  const delivered = await e.jobs.claim(jobId, panel.publicKey, 2);
  await e.orchestrator.idle();
  return { jobId, panel, delivered };
}

describe('C5 acceptance: the Outside help card turns consults on, and off', () => {
  test('enable via the card → private answer with gaps → fake writer and session → the outside block in the phase-2 envelope; disable → inert', async () => {
    const home = tempHome();
    const { env, fetcher } = dashboard(home);
    const custody = await controlSession(fetcher);

    // Before: nothing is sent, the file does not exist, every job binds off.
    // A job bound off never enters follow-up collection, so its envelope
    // carries no outside block at all (the pre-C4a plaintext shape).
    expect(readConsultSettings({ env }).state).toBe('absent');
    const before = engine(env);
    const idle = await answer(before);
    expectNoOutside(await envelope(idle.jobId, idle.panel, idle.delivered));
    expect(before.writerCalls).toEqual([]);
    expect(before.opens).toEqual([]);

    // The owner turns outside help on from the Mac dashboard.
    const revision = await setOutsideHelp(fetcher, custody, true, 0);
    expect(revision).toBe(1);
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 1, enabled: true, languages: ['en'] } });

    // A private answer with gaps: the consult runs and the block is appended.
    const on = engine(env);
    const { jobId, panel, delivered } = await answer(on);
    const first = await envelope(jobId, panel, delivered);
    expect(first.outside).toEqual({ state: 'idle' });
    expect(first.unanswered).toEqual(GAPS);
    expect(on.writerCalls).toEqual([{ question: QUESTION, answer: ANSWER, gaps: GAPS }]);
    expect(on.opens).toHaveLength(1);
    expect(on.sends).toEqual([{ question: CLEAN_QUESTION, authorized: true }]);
    const next = await envelope(jobId, panel, await on.jobs.claim(jobId, panel.publicKey, 2));
    expect(next.outside).toEqual({ state: 'appended', text: OUTSIDE_TEXT, question: CLEAN_QUESTION, route: 'zkAPI via Tor' });
    expect(next.answer).toBe(ANSWER);
    expect(next.unanswered).toEqual(GAPS);
    expect(on.logs.some((line) => line.startsWith('[consult] outcome=appended'))).toBe(true);
    for (const line of on.logs) {
      expect(line).not.toContain(CLEAN_QUESTION);
      expect(line).not.toContain(OUTSIDE_TEXT);
    }

    // A job created while on, turned off before delivery: final authorization refuses (stale revision); nothing is sent.
    const straddle = engine(env);
    const straddleJob = straddle.jobs.begin({ question: QUESTION, count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, caller: QUESTION }).jobId!;
    const off = await setOutsideHelp(fetcher, custody, false, revision);
    expect(off).toBe(2);
    const straddlePanel = await generatePanelKeyPair();
    expect((await straddle.jobs.claim(straddleJob, straddlePanel.publicKey, 2)).status).toBe(202);
    await settled(straddle.jobs);
    const straddleDelivered = await straddle.jobs.claim(straddleJob, straddlePanel.publicKey, 2);
    await straddle.orchestrator.idle();
    expect((await envelope(straddleJob, straddlePanel, straddleDelivered)).outside).toEqual({ state: 'idle' });
    expect(straddle.sends.every((send) => !send.authorized)).toBe(true);
    expect(straddle.logs.some((line) => line.includes('authorization_refused') || line.includes('settings_stale'))).toBe(true);
    expect((await envelope(straddleJob, straddlePanel, await straddle.jobs.claim(straddleJob, straddlePanel.publicKey, 2))).outside).toEqual({ state: 'idle' });

    // The later gate (P2-8): a job that passes the trigger, the writer and
    // the gate with outside help on, then has the settings change while the
    // session is already warm, reaches the real final authorize callback and
    // is refused there (stale revision): no dispatch, no reservation, the
    // block reads idle.
    const on2 = await setOutsideHelp(fetcher, custody, true, off);
    expect(on2).toBe(3);
    const late = engine(env);
    late.beforeAuthorize = async () => {
      expect(await setOutsideHelp(fetcher, custody, false, on2)).toBe(4);
    };
    const lateRun = await answer(late);
    expect(late.writerCalls).toHaveLength(1);
    expect(late.opens).toHaveLength(1);
    expect(late.authorizeCalls).toBe(1);
    expect(late.sends).toEqual([{ question: CLEAN_QUESTION, authorized: false }]);
    expect(late.logs.some((line) => line.includes('authorization_refused'))).toBe(true);
    expect(late.logs.some((line) => line.startsWith('[consult] outcome=appended'))).toBe(false);
    expect((await envelope(lateRun.jobId, lateRun.panel, await late.jobs.claim(lateRun.jobId, lateRun.panel.publicKey, 2))).outside).toEqual({ state: 'idle' });
    expect(late.orchestrator.recentQuestions).toEqual([]);

    // Off: inert. No writer, no session, idle.
    const after = engine(env);
    const quiet = await answer(after);
    expectNoOutside(await envelope(quiet.jobId, quiet.panel, quiet.delivered));
    expect(after.writerCalls).toEqual([]);
    expect(after.opens).toEqual([]);
    expect(after.sends).toEqual([]);
  }, 30_000);
});
