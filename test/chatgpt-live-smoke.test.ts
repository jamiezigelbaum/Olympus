// The live smoke harness's offline pieces: the panel's claim/poll/decrypt
// loop against a fake relay, and the checks that keep private content out of
// what ChatGPT receives. The network run itself is scripts/chatgpt-live-smoke.ts.

import { describe, expect, test } from 'bun:test';
import {
  collectPrivateAnswer,
  findPrivateLeaks,
  PANEL_FULL_POLL_CAP_MS,
  parseSmokeArgs,
  privateNoteKind,
  readPanelPlaintext,
  redactJobId,
  resultText,
  type ToolResultLike,
} from '../scripts/chatgpt-live-smoke.ts';
import { PRIVATE_ANSWER_META_KEY } from '../src/workers/chatgpt/private-answer-contract.ts';
import { CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS } from '../src/workers/dashboard/chatgpt/private-answer.ts';
import { importPanelPublicKey, sealPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PRIVATE_MATCH_PANEL_FULL_NOTE, PRIVATE_MATCH_PANEL_NOTE } from '../src/workers/chatgpt/response-builder.ts';

const RELAY = 'https://relay.test';
const JOB = `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}`;
const ORIGIN = 'codex-sandbox://mcp-app-0123abcd.web-sandbox.oaiusercontent.com';
const PLAINTEXT = {
  v: 1,
  answer: 'Your June 2026 panel shows ferritin at 41.5 ng/mL and a normal thyroid result overall.',
  citations: [{ title: 'Lab report June 2026', date: '2026-06-12', open: { kind: 'mac', token: 'OPEN_TOKEN_SENTINEL_123' } }],
  unanswered: ['The report does not list vitamin D.'],
};

interface Call { method: string; headers: Headers; body?: string }

/** A fake relay: preflight, then the scripted POST answers, sealing `ready` to the posted key. */
function fakeRelay(script: Array<{ status: number; body?: Record<string, unknown>; retryAfter?: string; seal?: boolean }>, origin = ORIGIN) {
  const calls: Call[] = [];
  let step = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    calls.push({ method, headers, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    expect(String(input)).toBe(`${RELAY}/private/${JOB}`);
    const cors = { 'access-control-allow-origin': origin };
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const next = script[Math.min(step, script.length - 1)]!;
    step += 1;
    let body = next.body ?? {};
    if (next.seal) {
      const posted = JSON.parse(String(init?.body)) as { publicKey: string };
      const key = await importPanelPublicKey(posted.publicKey);
      const sealed = await sealPrivateAnswer(JOB, key!.key, JSON.stringify(PLAINTEXT));
      body = { status: 'ready', v: 1, ...sealed };
    }
    return new Response(JSON.stringify(body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...cors, ...(next.retryAfter ? { 'retry-after': next.retryAfter } : {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

describe('panel collection', () => {
  test('claims with one key, polls on 202, and decrypts the sealed answer', async () => {
    const relay = fakeRelay([
      { status: 202, body: { status: 'pending' }, retryAfter: '2' },
      { status: 202, body: { status: 'pending' }, retryAfter: '2' },
      { status: 200, seal: true },
    ]);
    const time = clock();
    const outcome = await collectPrivateAnswer({ relay: RELAY, jobId: JOB, origin: ORIGIN, full: false, fetch: relay.fetchImpl, ...time });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.answer.answer).toBe(PLAINTEXT.answer);
    expect(outcome.answer.citations[0]?.title).toBe('Lab report June 2026');
    expect(outcome.answer.unanswered).toEqual(PLAINTEXT.unanswered);
    expect(outcome.polls).toBe(3);
    expect(outcome.claimMs).toBe(4000);
    expect(relay.calls[0]!.method).toBe('OPTIONS');
    const posts = relay.calls.filter((c) => c.method === 'POST');
    expect(posts.every((c) => c.headers.get('origin') === ORIGIN)).toBe(true);
    // The same key on every poll, as the panel does.
    expect(new Set(posts.map((c) => c.body)).size).toBe(1);
  });

  test('a claimed job, a failed model and a disallowed origin are failures', async () => {
    for (const [script, status] of [
      [[{ status: 409, body: { status: 'claimed' } }], 'claimed'],
      [[{ status: 200, body: { status: 'failed' } }], 'failed'],
      [[{ status: 410, body: { status: 'gone' } }], 'gone'],
      [[{ status: 503, body: { status: 'mac_offline' } }], 'mac_offline'],
    ] as const) {
      const relay = fakeRelay([...script]);
      const outcome = await collectPrivateAnswer({ relay: RELAY, jobId: JOB, origin: ORIGIN, full: false, fetch: relay.fetchImpl, ...clock() });
      expect(outcome.ok ? 'ok' : outcome.status).toBe(status);
    }
    const wrongOrigin = fakeRelay([{ status: 200, seal: true }], 'https://elsewhere.test');
    const outcome = await collectPrivateAnswer({ relay: RELAY, jobId: JOB, origin: ORIGIN, full: false, fetch: wrongOrigin.fetchImpl, ...clock() });
    expect(outcome.ok ? 'ok' : outcome.status).toBe('cors');
  });

  test('stops at the panel cap: 2 min summary, the panel\'s full-detail cap for full', async () => {
    const pending = [{ status: 202, body: { status: 'pending' }, retryAfter: '2' }];
    const summary = await collectPrivateAnswer({ relay: RELAY, jobId: JOB, origin: ORIGIN, full: false, fetch: fakeRelay(pending).fetchImpl, ...clock() });
    expect(summary.ok ? 'ok' : summary.status).toBe('slow');
    expect(summary.claimMs).toBeLessThanOrEqual(120_000);
    expect(summary.claimMs).toBeGreaterThan(115_000);
    const full = await collectPrivateAnswer({ relay: RELAY, jobId: JOB, origin: ORIGIN, full: true, fetch: fakeRelay(pending).fetchImpl, ...clock() });
    expect(full.claimMs).toBeGreaterThan(PANEL_FULL_POLL_CAP_MS - 10_000);
    expect(full.claimMs).toBeLessThanOrEqual(PANEL_FULL_POLL_CAP_MS);
    expect(PANEL_FULL_POLL_CAP_MS).toBe(CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS);
  });

  test('reads only a v1 plaintext', () => {
    expect(readPanelPlaintext(JSON.stringify(PLAINTEXT) + '    ')?.answer).toBe(PLAINTEXT.answer);
    expect(readPanelPlaintext('{"v":2,"answer":"x"}')).toBeUndefined();
    expect(readPanelPlaintext('not json')).toBeUndefined();
  });
});

describe('private content never reaches tool output', () => {
  const clean: ToolResultLike = {
    content: [{ type: 'text', text: `Here is what Olympus found in Personal items.\n${PRIVATE_MATCH_PANEL_NOTE}` }],
    structuredContent: { status: 'answered', evidence: [{ title: 'Lab report June 2026' }] },
    _meta: { [PRIVATE_ANSWER_META_KEY]: { v: 1, count: 2, state: 'ready', jobId: JOB } },
  };
  const seen = [{ answer: PLAINTEXT.answer, secrets: ['OPEN_TOKEN_SENTINEL_123'] }];

  test('a clean result passes; a cited title alone is not a leak', () => {
    expect(findPrivateLeaks(clean, seen, 'What did my June 2026 blood work show?')).toEqual({ violations: [], warnings: [] });
    expect(privateNoteKind(resultText(clean))).toBe('panel');
    expect(privateNoteKind(PRIVATE_MATCH_PANEL_FULL_NOTE)).toBe('panel_full');
  });

  test('a phrase of the private answer in the text or structuredContent fails', () => {
    const inText = { ...clean, content: [{ type: 'text', text: 'Olympus says ferritin at 41.5 ng/mL and a normal thyroid result.' }] };
    expect(findPrivateLeaks(inText, seen).violations.join('\n')).toContain('phrase(s) of private answer #1');
    const inStructured = { ...clean, structuredContent: { answer: 'shows ferritin at 41.5 ng/mL and a normal' } };
    expect(findPrivateLeaks(inStructured, seen).violations.length).toBeGreaterThan(0);
  });

  test('the question echoed back is not counted against the private answer', () => {
    const echo = { ...clean, content: [{ type: 'text', text: 'You asked: your june 2026 panel shows ferritin at' }] };
    expect(findPrivateLeaks(echo, seen, 'your June 2026 panel shows ferritin at').violations).toEqual([]);
  });

  test('the job id in model-visible output, extra panel fields, key material and open tokens fail', () => {
    const jobInText = { ...clean, content: [{ type: 'text', text: `job ${JOB}` }] };
    expect(findPrivateLeaks(jobInText).violations).toContain('the private answer job id appears in model-visible output');
    const extraField = { ...clean, _meta: { [PRIVATE_ANSWER_META_KEY]: { v: 1, count: 1, state: 'ready', jobId: JOB, answer: 'x' } } };
    expect(findPrivateLeaks(extraField).violations).toContain('panel _meta carries an unexpected field "answer"');
    const keyMaterial = { ...clean, structuredContent: { macPublicKey: 'x' } };
    expect(findPrivateLeaks(keyMaterial).violations.join('\n')).toContain('key material field "macPublicKey"');
    const token = { ...clean, structuredContent: { note: 'OPEN_TOKEN_SENTINEL_123' } };
    expect(findPrivateLeaks(token, seen).violations.join('\n')).toContain('sealed plaintext appears');
  });

  test('a shared decimal value is a warning, not a failure', () => {
    const decimal = { ...clean, content: [{ type: 'text', text: 'An older result was 41.5 in 2024.' }] };
    const report = findPrivateLeaks(decimal, seen);
    expect(report.violations).toEqual([]);
    expect(report.warnings.length).toBe(1);
  });
});

describe('arguments', () => {
  test('question, follow-up and detail', () => {
    const options = parseSmokeArgs(['--question', 'Q1', '--follow-up', 'Q2', '--follow-up-detail', 'full', '--quiet'], '/home/x');
    expect(options.questions).toEqual([{ question: 'Q1', detail: 'summary' }, { question: 'Q2', detail: 'full' }]);
    expect(options.quiet).toBe(true);
    expect(options.stateFile).toBe('/home/x/.olympus/live-smoke-client.json');
    expect(options.origin).toMatch(/^codex-sandbox:\/\/mcp-app-[0-9a-f]{16}\.web-sandbox\.oaiusercontent\.com$/);
  });

  test('approval stays loopback-only and bad flags are refused', () => {
    expect(() => parseSmokeArgs(['--engine', 'https://mcp.olympusplugin.ai'])).toThrow('loopback');
    expect(() => parseSmokeArgs(['--follow-up', 'Q2'])).toThrow('--question');
    expect(() => parseSmokeArgs(['--detail', 'all'])).toThrow('summary or full');
    expect(redactJobId(JOB)).toBe(`oly2p.${'a'.repeat(32)}.<redacted>`);
  });
});

