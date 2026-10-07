// Follow-up collection on the jobs engine (design docs/design/frontier-consult-lane.md
// §A.5.2–A.5.6, stage C4a; AD-2 in private-answer-contract.ts):
//
// - a job binds the outside-help policy current at its creation, and its
//   lifetime follows that policy, never a consult's outcome;
// - phase 1 (initial acquisition) is unchanged; the first `ready` to the
//   claiming key is the transition into phase 2 for a capability-2 panel on
//   a job with outside help on;
// - in phase 2 every request gets `200 ready` with a fresh seal and an
//   envelope of exactly 36,864 padded bytes carrying the current state:
//   idle, pending, appended, paused, withdrawn, replayed, reopened;
// - withdrawal is terminal and lives inside the envelope; a late reply never
//   restores it; source-open tokens are identical in every envelope;
// - revisions only increase (compare-and-set); the follow-up window is fixed
//   at first delivery, capped by expiry, and a remount never extends it;
// - old panels and jobs with outside help off keep today's behavior exactly;
// - a job with outside help on lives 30 minutes; eviction is oldest-first.
//
// No consult is written or sent here: the C4b seams are exercised directly.
// The content is sealed; that outside help ran may be inferred from timing,
// sizes and polling (owner ruling 2026-10-07): nothing here claims otherwise.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONSULT_SETTINGS, bindConsultJobPolicy, type ConsultJobPolicy } from '../src/core/consult-settings.ts';
import {
  PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS,
  PRIVATE_ANSWER_JOB_TTL_MS,
  PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS,
  type PrivateAnswerEnvelopeV1,
  type PrivateAnswerModel,
} from '../src/workers/chatgpt/private-answer-contract.ts';
import {
  PRIVATE_ANSWER_PAD_BUCKETS,
  fromBase64Url,
  generatePanelKeyPair,
  importPanelPublicKey,
  openPrivateAnswer,
  padPrivateAnswerPlaintext,
  sealPrivateAnswer,
  type SealedPrivateAnswer,
} from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler, type ClaimResponse } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { PRIVATE_ANSWER_ENVELOPE_BYTES, padPrivateAnswerEnvelope, serializePrivateAnswerEnvelope, utf8Bytes } from '../src/workers/chatgpt/private-answer-payload.ts';

const ALL_ELIGIBLE = async (items: readonly unknown[]) => items.map(() => true);
const INSTALL = 'f'.repeat(32);
const PANEL_ORIGIN = 'https://olympus.web-sandbox.oaiusercontent.com';
const SECRET_ANSWER = 'SENTINEL_FOLLOW_UP_ANSWER_3c9e: the lease ends in May.';
const SECRET_OUTSIDE = 'SENTINEL_OUTSIDE_TEXT_3c9e: leases of this kind usually renew yearly.';
const EVIDENCE = [{ title: 'SENTINEL_EVIDENCE_3c9e', trust_domain: 'secure_local' }];
const ON: ConsultJobPolicy = bindConsultJobPolicy({ state: 'valid', settings: { ...DEFAULT_CONSULT_SETTINGS, revision: 7, enabled: true } });
const OFF: ConsultJobPolicy = bindConsultJobPolicy({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });

function readyModel(overrides: Partial<PrivateAnswerModel> = {}): PrivateAnswerModel {
  return {
    status: () => ({ state: 'ready' }),
    answerPrivately: async () => ({
      answer: SECRET_ANSWER,
      citations: [{ title: 'Lease.pdf', source: 'Dropbox', date: '2026-04-01', localPath: '/tmp/olympus-follow-up-test/Lease.pdf' }, { title: 'Landlord email', url: 'https://mail.example/1' }],
      unanswered: ['the deposit'],
    }),
    ...overrides,
  };
}

interface Harness {
  jobs: PrivateAnswerJobs;
  clock: { now: number };
  opened: string[];
  eligible: { refuse: boolean };
}

function harness(policy: ConsultJobPolicy | (() => ConsultJobPolicy) | 'none' = ON, extra: Partial<ConstructorParameters<typeof PrivateAnswerJobs>[0]> = {}): Harness {
  const clock = { now: 1_000_000 };
  const opened: string[] = [];
  const eligible = { refuse: false };
  const jobs = new PrivateAnswerJobs({
    eligible: async (items) => items.map(() => !eligible.refuse),
    model: () => readyModel(),
    installId: () => INSTALL,
    now: () => clock.now,
    log: () => {},
    audit: () => {},
    claimHoldMs: 0,
    ...(policy === 'none' ? {} : { consultPolicy: typeof policy === 'function' ? policy : () => policy }),
    openFile: async (path) => { opened.push(path); },
    ...extra,
  });
  return { jobs, clock, opened, eligible };
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

function begin(h: Harness): string {
  return h.jobs.begin({ question: 'When does the lease end?', count: 2, evidence: EVIDENCE, refresh: async () => EVIDENCE }).jobId!;
}

/** Claims with capability 2 and waits for first delivery; returns the first envelope. */
async function deliver(h: Harness, jobId: string, panel: Awaited<ReturnType<typeof generatePanelKeyPair>>, cap: 1 | 2 = 2) {
  const first = await h.jobs.claim(jobId, panel.publicKey, cap);
  expect(first).toMatchObject({ status: 202, body: { status: 'pending' }, retryAfterSeconds: 2 });
  await settled(h.jobs);
  return h.jobs.claim(jobId, panel.publicKey, cap);
}

async function envelope(jobId: string, panel: Awaited<ReturnType<typeof generatePanelKeyPair>>, response: ClaimResponse): Promise<{ plaintext: string; parsed: PrivateAnswerEnvelopeV1 }> {
  expect(response.status).toBe(200);
  expect(response.body.status).toBe('ready');
  const plaintext = await openPrivateAnswer(jobId, panel.privateKey, response.body as unknown as SealedPrivateAnswer);
  return { plaintext, parsed: JSON.parse(plaintext) as PrivateAnswerEnvelopeV1 };
}

const wireShape = (response: ClaimResponse) => ({
  status: response.status,
  keys: Object.keys(response.body).sort(),
  ciphertextBytes: fromBase64Url(String(response.body.ciphertext))!.byteLength,
  bodyChars: JSON.stringify(response.body).length,
});

describe('job policy', () => {
  test('bound at creation: the lifetime follows it, and a later change to the settings never alters a live job', async () => {
    let policy = ON;
    const h = harness(() => policy);
    const on = begin(h);
    policy = OFF;
    const off = begin(h);
    policy = ON;
    const panel = await generatePanelKeyPair();
    const other = await generatePanelKeyPair();
    const onFirst = await deliver(h, on, panel);
    const offFirst = await deliver(h, off, other);
    // The `on` job follows the envelope protocol; the `off` job, created while off, keeps today's bytes even though the settings are on again.
    expect(utf8Bytes((await envelope(on, panel, onFirst)).plaintext)).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
    expect(utf8Bytes(await openPrivateAnswer(off, other.privateKey, offFirst.body as unknown as SealedPrivateAnswer))).toBe(PRIVATE_ANSWER_PAD_BUCKETS[0]);
    expect(h.jobs.outsideSeam(on)!.policy).toEqual(ON);
    expect(h.jobs.outsideSeam(off)).toBeUndefined();
    // Lifetimes: 30 minutes with outside help on, 10 off.
    h.clock.now += PRIVATE_ANSWER_JOB_TTL_MS;
    expect((await h.jobs.claim(off, other.publicKey, 2)).status).toBe(410);
    expect((await h.jobs.claim(on, panel.publicKey, 2)).status).toBe(200);
    h.clock.now += PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS - PRIVATE_ANSWER_JOB_TTL_MS;
    expect((await h.jobs.claim(on, panel.publicKey, 2)).status).toBe(410);
    expect(PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS).toBe(30 * 60_000);
    expect(PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS).toBe(20 * 60_000);
  });

  test('a reader that throws, returns junk, or no reader at all: outside help off', async () => {
    for (const h of [harness(() => { throw new Error('boom'); }), harness(() => 'junk' as unknown as ConsultJobPolicy), harness('none')]) {
      const jobId = begin(h);
      const panel = await generatePanelKeyPair();
      const first = await deliver(h, jobId, panel);
      expect(utf8Bytes(await openPrivateAnswer(jobId, panel.privateKey, first.body as unknown as SealedPrivateAnswer))).toBe(PRIVATE_ANSWER_PAD_BUCKETS[0]);
      expect(h.jobs.outsideSeam(jobId)).toBeUndefined();
    }
  });
});

describe('two phases', () => {
  test('phase 1 is unchanged; the first ready is the transition into a fixed 36 KiB envelope with the follow-up clock', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    expect(h.jobs.outsideSeam(jobId)).toBeUndefined();
    const first = await deliver(h, jobId, panel);
    const { plaintext, parsed } = await envelope(jobId, panel, first);
    expect(utf8Bytes(plaintext)).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
    expect(Object.keys(parsed)).toEqual(['v', 'rev', 'state', 'answer', 'citations', 'unanswered', 'followSeconds', 'outside']);
    expect(parsed).toMatchObject({ v: 1, rev: 1, state: 'answer', answer: SECRET_ANSWER, unanswered: ['the deposit'], followSeconds: 1_200, outside: { state: 'idle' } });
    expect(parsed.citations![0]!.open).toMatchObject({ kind: 'mac' });
    expect(parsed.citations![1]!.open).toEqual({ kind: 'web', url: 'https://mail.example/1' });
    const seam = h.jobs.outsideSeam(jobId)!;
    expect(seam).toMatchObject({ rev: 1, state: 'answer', outside: 'idle', panelCapability: 2, firstDeliveredAt: h.clock.now, followUntil: h.clock.now + PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS, lastCollectedAt: h.clock.now });
    // Nothing on the wire names the answer or the outside text.
    expect(JSON.stringify(first.body)).not.toContain('SENTINEL');
  });

  test('every phase-2 request is a freshly sealed envelope of the fixed size carrying the current state', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    const first = await deliver(h, jobId, panel);
    const shapes: Array<ReturnType<typeof wireShape>> = [wireShape(first)];
    const seen: string[] = [JSON.stringify(first.body)];
    const states: string[] = [];
    const observe = async (label: string) => {
      const response = await h.jobs.claim(jobId, panel.publicKey, 2);
      shapes.push(wireShape(response));
      const body = JSON.stringify(response.body);
      expect(seen).not.toContain(body);
      seen.push(body);
      const { plaintext, parsed } = await envelope(jobId, panel, response);
      expect(utf8Bytes(plaintext)).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
      states.push(`${label}:${parsed.state}/${parsed.outside.state}/rev${parsed.rev}`);
      return parsed;
    };
    await observe('replay');
    expect(h.jobs.markOutside(jobId, 1, 'pending')).toEqual({ ok: true, rev: 2 });
    await observe('pending');
    expect(h.jobs.markOutside(jobId, 2, 'paused')).toEqual({ ok: true, rev: 3 });
    await observe('paused');
    expect(h.jobs.markOutside(jobId, 3, 'pending')).toEqual({ ok: true, rev: 4 });
    expect(h.jobs.appendOutsideBlock(jobId, 4, { text: SECRET_OUTSIDE, question: 'How do leases renew?', route: 'zkAPI' })).toEqual({ ok: true, rev: 5 });
    const appended = await observe('appended');
    expect(appended.outside).toEqual({ state: 'appended', text: SECRET_OUTSIDE, question: 'How do leases renew?', route: 'zkAPI' });
    expect(appended.answer).toBe(SECRET_ANSWER);
    // Reopen: the same key, minutes later, gets the same state again, freshly sealed.
    h.clock.now += 5 * 60_000;
    const reopened = await observe('reopen');
    expect(reopened.followSeconds).toBe(1_200 - 300);
    // Withdrawn: the live guard refuses an item the answer read.
    h.eligible.refuse = true;
    const withdrawn = await observe('withdrawn');
    expect(withdrawn).toEqual({ v: 1, rev: 6, state: 'withdrawn', followSeconds: 900, outside: { state: 'idle' } });
    await observe('withdrawn-replay');
    expect(states).toEqual([
      'replay:answer/idle/rev1', 'pending:answer/pending/rev2', 'paused:answer/paused/rev3', 'appended:answer/appended/rev5',
      'reopen:answer/appended/rev5', 'withdrawn:withdrawn/idle/rev6', 'withdrawn-replay:withdrawn/idle/rev6',
    ]);
    // The fixed-size envelope: one wire shape (status, keys, ciphertext length, body length) in every state.
    for (const shape of shapes) expect(shape).toEqual(shapes[0]!);
    expect(shapes[0]!.ciphertextBytes).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES + 16);
    expect(shapes[0]!.status).toBe(200);
    // Every response was a different seal (fresh engine key and IV).
    expect(new Set(seen).size).toBe(seen.length);
    for (const body of seen) expect(body).not.toContain('SENTINEL');
  });

  test('withdrawal is terminal: the answer, the outside text and the open tokens are gone, and a late reply never restores it', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    const first = await envelope(jobId, panel, await deliver(h, jobId, panel));
    const token = (first.parsed.citations![0]!.open as { token: string }).token;
    expect(h.jobs.appendOutsideBlock(jobId, 1, { text: SECRET_OUTSIDE })).toEqual({ ok: true, rev: 2 });
    h.eligible.refuse = true;
    // A source open is refused first (E4), which also withdraws the answer.
    expect((await h.jobs.open(jobId, token)).status).toBe(410);
    const withdrawn = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(withdrawn.parsed.state).toBe('withdrawn');
    expect(withdrawn.plaintext).not.toContain('SENTINEL');
    expect(withdrawn.parsed.outside).toEqual({ state: 'idle' });
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ state: 'withdrawn', outside: 'idle', rev: 3 });
    // Eligible again: nothing restores a withdrawn job, and the C4b seams refuse it.
    h.eligible.refuse = false;
    expect(h.jobs.appendOutsideBlock(jobId, 3, { text: 'late reply' })).toEqual({ ok: false, reason: 'withdrawn' });
    expect(h.jobs.markOutside(jobId, 3, 'pending')).toEqual({ ok: false, reason: 'withdrawn' });
    const again = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(again.parsed).toEqual({ v: 1, rev: 3, state: 'withdrawn', followSeconds: 1_200, outside: { state: 'idle' } });
    expect((await h.jobs.open(jobId, token)).status).toBe(410);
    expect(h.opened).toEqual([]);
  });

  test('source-open tokens are minted once and identical in every envelope; they open the file', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    const first = await envelope(jobId, panel, await deliver(h, jobId, panel));
    h.jobs.appendOutsideBlock(jobId, 1, { text: SECRET_OUTSIDE });
    const later = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(later.parsed.citations).toEqual(first.parsed.citations);
    const token = (first.parsed.citations![0]!.open as { token: string }).token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // (The fixture path does not exist on disk, so the open answers gone; the token itself is accepted and rate-limited as before.)
    const response = await h.jobs.open(jobId, token);
    expect([204, 410]).toContain(response.status);
    expect((await h.jobs.open(jobId, 'B'.repeat(43))).status).toBe(410);
  });

  test('revisions only increase: the seams are compare-and-set, append once, never after the window', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    expect(h.jobs.appendOutsideBlock(jobId, 0, { text: 'x' })).toEqual({ ok: false, reason: 'unknown' });
    await h.jobs.claim(jobId, panel.publicKey, 2);
    await settled(h.jobs);
    // Claimed and ready, but not yet delivered: no outside writes.
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ state: 'answer', firstDeliveredAt: undefined });
    expect(h.jobs.markOutside(jobId, 1, 'pending')).toEqual({ ok: false, reason: 'not_delivered' });
    await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(h.jobs.markOutside(jobId, 0, 'pending')).toEqual({ ok: false, reason: 'stale_rev' });
    expect(h.jobs.markOutside(jobId, 1, 'pending')).toEqual({ ok: true, rev: 2 });
    expect(h.jobs.appendOutsideBlock(jobId, 1, { text: 'stale' })).toEqual({ ok: false, reason: 'stale_rev' });
    expect(h.jobs.appendOutsideBlock(jobId, 2, { text: SECRET_OUTSIDE })).toEqual({ ok: true, rev: 3 });
    expect(h.jobs.appendOutsideBlock(jobId, 3, { text: 'second' })).toEqual({ ok: false, reason: 'already_appended' });
    expect(h.jobs.markOutside(jobId, 3, 'idle')).toEqual({ ok: false, reason: 'already_appended' });
    const parsed = (await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).parsed;
    expect(parsed).toMatchObject({ rev: 3, outside: { state: 'appended', text: SECRET_OUTSIDE } });
    // Another job, delivered, then the window passes: a late append is refused and the panel is told 0 seconds.
    const late = begin(h);
    const other = await generatePanelKeyPair();
    await envelope(late, other, await deliver(h, late, other));
    h.clock.now += PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS;
    // At the boundary both seams still write; one millisecond later neither does.
    expect(h.jobs.markOutside(late, 1, 'pending')).toEqual({ ok: true, rev: 2 });
    expect(h.jobs.markOutside(late, 2, 'idle')).toEqual({ ok: true, rev: 3 });
    h.clock.now += 1;
    expect(h.jobs.markOutside(late, 3, 'pending')).toEqual({ ok: false, reason: 'window_closed' });
    expect(h.jobs.appendOutsideBlock(late, 3, { text: 'too late' })).toEqual({ ok: false, reason: 'window_closed' });
    const closed = (await envelope(late, other, await h.jobs.claim(late, other.publicKey, 2))).parsed;
    expect(closed).toMatchObject({ rev: 3, state: 'answer', followSeconds: 0, outside: { state: 'idle' } });
    expect(utf8Bytes(JSON.stringify(closed))).toBeLessThan(PRIVATE_ANSWER_ENVELOPE_BYTES);
  });

  test('the follow-up window is fixed at first delivery, capped by expiry, and a remount never extends it', async () => {
    const h = harness(ON, { outsideHelpTtlMs: 15 * 60_000 });
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    h.clock.now += 5 * 60_000;
    const first = (await envelope(jobId, panel, await deliver(h, jobId, panel))).parsed;
    // 20 minutes from first delivery would pass the 15-minute expiry: capped at the 10 minutes left.
    expect(first.followSeconds).toBe(600);
    h.clock.now += 4 * 60_000;
    const remount = (await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2))).parsed;
    expect(remount.followSeconds).toBe(360);
    expect(h.jobs.outsideSeam(jobId)!.followUntil).toBe(1_000_000 + 15 * 60_000);
    h.clock.now += 6 * 60_000;
    expect((await h.jobs.claim(jobId, panel.publicKey, 2)).status).toBe(410);
  });
});

describe('race rules around the seal (design §A.5.3)', () => {
  /** A guard whose n-th call runs `act` first: a state change between the engine's checks and its seal. */
  function interleaving(h: Harness, acts: Record<number, () => void>): { calls: number } {
    const counter = { calls: 0 };
    (h.jobs as unknown as { options: { eligible: (items: readonly unknown[]) => Promise<boolean[]> } }).options.eligible = async (items) => {
      counter.calls += 1;
      acts[counter.calls]?.();
      return items.map(() => !h.eligible.refuse);
    };
    return counter;
  }

  test('an outside write that lands while the envelope is sealed is never handed out stale: the response carries the newer revision', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await envelope(jobId, panel, await deliver(h, jobId, panel));
    // Per phase-2 request the guard runs before and after each seal: calls 1 and 2 belong to the first seal.
    const counter = interleaving(h, { 2: () => { expect(h.jobs.markOutside(jobId, 1, 'pending')).toEqual({ ok: true, rev: 2 }); } });
    const { parsed } = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(parsed).toMatchObject({ rev: 2, state: 'answer', outside: { state: 'pending' } });
    // Two seals: four guard calls.
    expect(counter.calls).toBe(4);
  });

  test('a withdrawal during the second seal wins: the response is the withdrawn envelope, never the stale ciphertext', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await envelope(jobId, panel, await deliver(h, jobId, panel));
    h.jobs.appendOutsideBlock(jobId, 1, { text: SECRET_OUTSIDE });
    const counter = interleaving(h, {
      2: () => { expect(h.jobs.markOutside(jobId, 2, 'pending')).toEqual({ ok: false, reason: 'already_appended' }); (h.jobs as unknown as { jobs: Map<string, { rev: number }> }).jobs.get(jobId)!.rev += 1; },
      4: () => { h.eligible.refuse = true; },
    });
    const response = await h.jobs.claim(jobId, panel.publicKey, 2);
    const { parsed, plaintext } = await envelope(jobId, panel, response);
    expect(parsed.state).toBe('withdrawn');
    expect(plaintext).not.toContain('SENTINEL');
    // Two seals of the answer (four guard calls); the withdrawn envelope needs no guard.
    expect(counter.calls).toBe(4);
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ state: 'withdrawn', outside: 'idle' });
  });

  test('a state that keeps moving past the retry budget withdraws the job and returns that, never a stale ciphertext', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await envelope(jobId, panel, await deliver(h, jobId, panel));
    const live = (h.jobs as unknown as { jobs: Map<string, { rev: number; outcome?: { kind: string } }> }).jobs.get(jobId)!;
    const counter = { calls: 0 };
    (h.jobs as unknown as { options: { eligible: (items: readonly unknown[]) => Promise<boolean[]> } }).options.eligible = async (items) => {
      counter.calls += 1;
      // Every post-seal check finds the revision moved, until the job is withdrawn.
      if (counter.calls % 2 === 0 && live.outcome?.kind === 'retained') live.rev += 1;
      return items.map(() => true);
    };
    const { parsed } = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(parsed.state).toBe('withdrawn');
    expect(counter.calls).toBeLessThanOrEqual(2 * 10);
    expect(h.jobs.outsideSeam(jobId)!.state).toBe('withdrawn');
  });

  test('a seal that throws leaves no delivery window; the next request delivers and fixes it then', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await h.jobs.claim(jobId, panel.publicKey, 2);
    await settled(h.jobs);
    const subtle = globalThis.crypto.subtle;
    const encrypt = subtle.encrypt;
    subtle.encrypt = () => Promise.reject(new Error('seal failed'));
    try {
      await expect(h.jobs.claim(jobId, panel.publicKey, 2)).rejects.toThrow('seal failed');
    } finally {
      subtle.encrypt = encrypt;
    }
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ state: 'answer', firstDeliveredAt: undefined, followUntil: undefined, lastCollectedAt: undefined });
    expect(h.jobs.markOutside(jobId, 1, 'pending')).toEqual({ ok: false, reason: 'not_delivered' });
    h.clock.now += 60_000;
    const { parsed } = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(parsed.followSeconds).toBe(1_200);
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ firstDeliveredAt: h.clock.now, followUntil: h.clock.now + PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS, lastCollectedAt: h.clock.now });
  });
});

describe('overlapping first collections commit one delivery window', () => {
  /** A guard whose calls can be held: `hold(n)` blocks the n-th call until released. */
  function gated(h: Harness) {
    const held = new Map<number, () => void>();
    const waiting = new Map<number, Promise<void>>();
    const counter = { calls: 0 };
    const hold = (n: number) => { waiting.set(n, new Promise<void>((resolve) => held.set(n, resolve))); };
    const release = (n: number) => { held.get(n)?.(); };
    (h.jobs as unknown as { options: { eligible: (items: readonly unknown[]) => Promise<boolean[]> } }).options.eligible = async (items) => {
      counter.calls += 1;
      await waiting.get(counter.calls);
      return items.map(() => !h.eligible.refuse);
    };
    const until = async (n: number) => { while (counter.calls < n) await Bun.sleep(1); };
    return { hold, release, until, counter };
  }

  async function prepared(): Promise<{ h: Harness; jobId: string; panel: Awaited<ReturnType<typeof generatePanelKeyPair>> }> {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    await h.jobs.claim(jobId, panel.publicKey, 2);
    await settled(h.jobs);
    return { h, jobId, panel };
  }

  test('B completes first: A, sealed over its own proposal, is sealed again over the committed window', async () => {
    const { h, jobId, panel } = await prepared();
    const g = gated(h);
    const t1 = h.clock.now;
    g.hold(2);
    const a = h.jobs.claim(jobId, panel.publicKey, 2);
    await g.until(2);
    // A has sealed over t1 + 20 min and is held at its post-seal check; B starts five seconds later and finishes.
    h.clock.now += 5_000;
    const t2 = h.clock.now;
    const b = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ firstDeliveredAt: t2, followUntil: t2 + PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS, lastCollectedAt: t2 });
    g.release(2);
    const aEnvelope = await envelope(jobId, panel, await a);
    expect(aEnvelope.parsed.followSeconds).toBe(b.parsed.followSeconds);
    expect(aEnvelope.parsed.followSeconds).toBe(1_200);
    // A sealed twice (its first ciphertext was over the wrong window): six guard calls in all.
    expect(g.counter.calls).toBe(6);
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ firstDeliveredAt: t2, followUntil: t2 + PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS, lastCollectedAt: t2 });
    expect(t1).toBeLessThan(t2);
  });

  test('A completes first: B, sealed over its own proposal, is sealed again over the committed window; lastCollectedAt never moves back', async () => {
    const { h, jobId, panel } = await prepared();
    const g = gated(h);
    const t1 = h.clock.now;
    g.hold(2);
    const a = h.jobs.claim(jobId, panel.publicKey, 2);
    await g.until(2);
    h.clock.now += 5_000;
    const t2 = h.clock.now;
    g.hold(4);
    const b = h.jobs.claim(jobId, panel.publicKey, 2);
    await g.until(4);
    // Both sealed over their own proposals; A is released first and commits t1's window.
    g.release(2);
    const aEnvelope = await envelope(jobId, panel, await a);
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ firstDeliveredAt: t1, followUntil: t1 + PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS, lastCollectedAt: t1 });
    g.release(4);
    const bEnvelope = await envelope(jobId, panel, await b);
    // Both report the committed deadline (t1 + 20 min): A from t1, B five seconds later.
    expect(aEnvelope.parsed.followSeconds).toBe(1_200);
    expect(bEnvelope.parsed.followSeconds).toBe(1_195);
    expect(g.counter.calls).toBe(6);
    expect(h.jobs.outsideSeam(jobId)).toMatchObject({ firstDeliveredAt: t1, followUntil: t1 + PRIVATE_ANSWER_FOLLOW_UP_WINDOW_MS, lastCollectedAt: t2 });
    // An earlier-started request finishing later never moves the last collection back.
    h.clock.now = t1;
    await h.jobs.claim(jobId, panel.publicKey, 2);
    expect(h.jobs.outsideSeam(jobId)!.lastCollectedAt).toBe(t2);
  });

  test('markOutside is idempotent: the same state again moves no revision and cannot drive the re-seal loop', async () => {
    const { h, jobId, panel } = await prepared();
    await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(h.jobs.markOutside(jobId, 1, 'pending')).toEqual({ ok: true, rev: 2 });
    for (let i = 0; i < 20; i += 1) expect(h.jobs.markOutside(jobId, 2, 'pending')).toEqual({ ok: true, rev: 2 });
    // A writer repeating itself at every guard call: the response still arrives, at revision 2, not withdrawn.
    const counter = { calls: 0 };
    (h.jobs as unknown as { options: { eligible: (items: readonly unknown[]) => Promise<boolean[]> } }).options.eligible = async (items) => {
      counter.calls += 1;
      h.jobs.markOutside(jobId, 2, 'pending');
      return items.map(() => true);
    };
    const { parsed } = await envelope(jobId, panel, await h.jobs.claim(jobId, panel.publicKey, 2));
    expect(parsed).toMatchObject({ rev: 2, state: 'answer', outside: { state: 'pending' } });
    expect(counter.calls).toBe(2);
    expect(h.jobs.markOutside(jobId, 2, 'idle')).toEqual({ ok: true, rev: 3 });
  });
});

describe('what a job retains', () => {
  type LiveJob = { question?: string; outcome?: { kind: string; answer?: unknown }; outside: unknown; opens?: unknown; sealedItems?: unknown; guardItems?: unknown; evidence?: unknown; refresh?: unknown };
  const live = (h: Harness, id: string) => (h.jobs as unknown as { jobs: Map<string, LiveJob> }).jobs.get(id)!;

  test('the question leaves the job once the claim has read it; a withdrawal clears everything but the item identities', async () => {
    const h = harness();
    const jobId = begin(h);
    expect(live(h, jobId).question).toBe('When does the lease end?');
    const panel = await generatePanelKeyPair();
    const first = await envelope(jobId, panel, await deliver(h, jobId, panel));
    const job = live(h, jobId);
    expect(job.question).toBeUndefined();
    expect(job.evidence).toBeUndefined();
    expect(job.refresh).toBeUndefined();
    expect(job.outcome?.kind).toBe('retained');
    expect(job.opens).toBeDefined();
    h.jobs.appendOutsideBlock(jobId, 1, { text: SECRET_OUTSIDE, question: 'How do leases renew?' });
    h.eligible.refuse = true;
    await h.jobs.claim(jobId, panel.publicKey, 2);
    expect(job.outcome).toEqual({ kind: 'withdrawn' });
    expect(job.outside).toEqual({ state: 'idle' });
    expect(job.question).toBeUndefined();
    expect(job.opens).toBeUndefined();
    expect(job.sealedItems).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain('SENTINEL');
    expect(JSON.stringify(job)).not.toContain('lease');
    expect(first.parsed.answer).toBe(SECRET_ANSWER);
  });

  test('a job holds only the fitted first answer and the fitted outside block: 200 jobs with maximal blocks stay inside 200 envelopes', async () => {
    const h = harness(ON, { maxJobs: 200, claimRate: { capacity: 10_000, refillPerSecond: 0 } });
    const panel = await generatePanelKeyPair();
    const huge = Array.from({ length: 3_000 }, (_, index) => `line ${index} ${'日本語'.repeat(200)}`).join('\n');
    const ids: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const id = begin(h);
      ids.push(id);
      await envelope(id, panel, await deliver(h, id, panel));
      expect(h.jobs.appendOutsideBlock(id, 1, { text: huge, question: huge, route: huge })).toEqual({ ok: true, rev: 2 });
    }
    let total = 0;
    for (const id of ids) {
      const job = live(h, id);
      const retained = utf8Bytes(JSON.stringify(job.outcome?.answer)) + utf8Bytes(JSON.stringify(job.outside));
      expect(utf8Bytes(JSON.stringify(job.outside))).toBeLessThanOrEqual(6_144);
      expect((job.outside as { cut?: boolean }).cut).toBe(true);
      expect(Object.keys(job.outside as object).sort()).toEqual(['cut', 'question', 'route', 'state', 'text']);
      total += retained;
    }
    expect(total).toBeLessThanOrEqual(200 * 35_328);
  }, 60_000);
});

describe('mixed versions and jobs outside the protocol keep today\'s behavior', () => {
  test('an old panel (no cap) on a job with outside help on: bucket padding, stored bytes, plaintext failed', async () => {
    const h = harness();
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    const first = await deliver(h, jobId, panel, 1);
    const plaintext = await openPrivateAnswer(jobId, panel.privateKey, first.body as unknown as SealedPrivateAnswer);
    expect(utf8Bytes(plaintext)).toBe(PRIVATE_ANSWER_PAD_BUCKETS[0]);
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['v', 'answer', 'citations', 'unanswered']);
    expect(parsed).not.toHaveProperty('outside');
    expect(parsed).not.toHaveProperty('followSeconds');
    // Replays return the identical bytes; a later cap: 2 changes nothing (the capability is recorded at the claim).
    expect(await h.jobs.claim(jobId, panel.publicKey, 2)).toEqual(first);
    expect(h.jobs.outsideSeam(jobId)).toBeUndefined();
    expect(h.jobs.appendOutsideBlock(jobId, 0, { text: 'x' })).toEqual({ ok: false, reason: 'unknown' });
    h.eligible.refuse = true;
    expect(await h.jobs.claim(jobId, panel.publicKey, 1)).toEqual({ status: 200, body: { status: 'failed' } });
    // The lifetime still follows the policy bound at creation.
    expect(h.jobs.size).toBe(1);
    h.clock.now += PRIVATE_ANSWER_JOB_TTL_MS + 1;
    expect((await h.jobs.claim(jobId, panel.publicKey, 1)).status).toBe(200);
  });

  test('a new panel (cap 2) on a job with outside help off: today\'s behavior exactly', async () => {
    const h = harness(OFF);
    const jobId = begin(h);
    const panel = await generatePanelKeyPair();
    const first = await deliver(h, jobId, panel, 2);
    expect(utf8Bytes(await openPrivateAnswer(jobId, panel.privateKey, first.body as unknown as SealedPrivateAnswer))).toBe(PRIVATE_ANSWER_PAD_BUCKETS[0]);
    expect(await h.jobs.claim(jobId, panel.publicKey, 2)).toEqual(first);
    expect(h.jobs.outsideSeam(jobId)).toBeUndefined();
    h.eligible.refuse = true;
    expect(await h.jobs.claim(jobId, panel.publicKey, 2)).toEqual({ status: 200, body: { status: 'failed' } });
  });

  test('the handler reads cap from the body; a body without it is capability 1', async () => {
    const h = harness();
    const handler = createPrivateAnswerHandler({ jobs: h.jobs, isRelayed: () => true });
    const post = (jobId: string, body: unknown) => handler(new Request(`http://127.0.0.1:8010/private/${jobId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PANEL_ORIGIN },
      body: JSON.stringify(body),
    }));
    const newPanel = await generatePanelKeyPair();
    const oldPanel = await generatePanelKeyPair();
    const withCap = begin(h);
    const withoutCap = begin(h);
    const request = { v: 1, publicKey: newPanel.publicKey, cap: 2 };
    expect(utf8Bytes(JSON.stringify(request))).toBeLessThanOrEqual(512);
    expect((await post(withCap, request)).status).toBe(202);
    expect((await post(withoutCap, { v: 1, publicKey: oldPanel.publicKey })).status).toBe(202);
    await settled(h.jobs);
    const sealed = await (await post(withCap, request)).json() as SealedPrivateAnswer & { status: string };
    expect(utf8Bytes(await openPrivateAnswer(withCap, newPanel.privateKey, sealed))).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
    const plain = await (await post(withoutCap, { v: 1, publicKey: oldPanel.publicKey })).json() as SealedPrivateAnswer;
    expect(utf8Bytes(await openPrivateAnswer(withoutCap, oldPanel.privateKey, plain))).toBe(PRIVATE_ANSWER_PAD_BUCKETS[0]);
    // A junk cap is capability 1.
    const junk = begin(h);
    const third = await generatePanelKeyPair();
    expect((await post(junk, { v: 1, publicKey: third.publicKey, cap: '2' })).status).toBe(202);
    await settled(h.jobs);
    expect(h.jobs.outsideSeam(junk)).toBeUndefined();
  });
});

describe('lifetime and eviction', () => {
  test('jobs with outside help on expire at the policy lifetime; eviction at the cap is oldest-first', async () => {
    const h = harness(ON, { maxJobs: 4 });
    const panel = await generatePanelKeyPair();
    const ids = [begin(h), begin(h), begin(h), begin(h)];
    for (const id of ids) await envelope(id, panel, await deliver(h, id, panel));
    h.jobs.markOutside(ids[1]!, 1, 'pending');
    h.jobs.appendOutsideBlock(ids[2]!, 1, { text: SECRET_OUTSIDE });
    h.eligible.refuse = true;
    expect((await envelope(ids[3]!, panel, await h.jobs.claim(ids[3]!, panel.publicKey, 2))).parsed.state).toBe('withdrawn');
    h.eligible.refuse = false;
    // Expiry: all four at the policy lifetime.
    h.clock.now += PRIVATE_ANSWER_OUTSIDE_HELP_JOB_TTL_MS - 1;
    for (const id of ids) expect((await h.jobs.claim(id, panel.publicKey, 2)).status).toBe(200);
    h.clock.now += 1;
    for (const id of ids) expect((await h.jobs.claim(id, panel.publicKey, 2)).status).toBe(410);
    expect(h.jobs.size).toBe(0);
    // Eviction at the cap: the oldest goes.
    const more = [begin(h), begin(h), begin(h), begin(h)];
    for (const id of more) await envelope(id, panel, await deliver(h, id, panel));
    h.jobs.appendOutsideBlock(more[0]!, 1, { text: SECRET_OUTSIDE });
    const fifth = begin(h);
    expect(h.jobs.size).toBe(4);
    expect((await h.jobs.claim(more[0]!, panel.publicKey, 2)).status).toBe(410);
    expect((await h.jobs.claim(more[1]!, panel.publicKey, 2)).status).toBe(200);
    expect(h.jobs.outsideSeam(fifth)).toBeUndefined();
    expect(h.jobs.appendOutsideBlock(more[0]!, 2, { text: 'for an evicted job' })).toEqual({ ok: false, reason: 'unknown' });
  });
});
