// The consult writer (src/core/consult-writer.ts; design
// docs/design/frontier-consult-lane.md §A.3 and §A.7, stage C4b): its
// prompt and bounds (with the rule against naming what the answer only
// implies; the gate-level proof for "Portugal" is in consult-gate-snapshot.test.ts),
// the reply form, the memory rule, and the lifecycle of its own server
// process: started on demand, SIGKILLed (never SIGTERMed) on a fresh answer
// or at the deadline at any stage (the tokenizer included), not started under
// the memory rule, never asked past the token bound, and skipped when the
// server cannot count tokens.
// Every process and model call here is a fake; no llama-server runs.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  CONSULT_WRITER_LIMITS,
  CONSULT_WRITER_RESPONSE_SCHEMA,
  CONSULT_WRITER_SYSTEM,
  CONSULT_WRITER_SYSTEM_UNNAMED,
  boundConsultWriterInput,
  consultWriterSystem,
  buildConsultWriterPrompt,
  consultWriterMemoryDecision,
  createConsultWriterServer,
  defaultConsultMemoryProbe,
  consultWriterEvidence,
  parseConsultWriterReply,
  runConsultWriter,
  runOwnConsultWriter,
  type ConsultMemorySample,
  type ConsultWriterServer,
} from '../src/core/consult-writer.ts';
import { createHash } from 'node:crypto';
import { llamaServerArguments } from '../src/workers/source-index/built-in-reasoning/server.ts';

const GB = 1024 * 1024 * 1024;
/**
 * sha256 of CONSULT_WRITER_SYSTEM, the Strict rules. Updated deliberately on
 * 2026-10-10 (owner decision: the skill-style rewrite without a single
 * anchoring example; docs/design/consult-writer-instructions.md). Before it:
 * 96ed8cbfa207c7087302edbe065c19592046e0e089326333721bf5db29be4879.
 */
const GENERAL_SYSTEM_SHA256 = 'f7ca6f93e68659c513d8648e6d825e179e169795a11cdbafec5bf1f7fbc08ed8';
const NORMAL: ConsultMemorySample = { totalBytes: 24 * GB, freePercent: 40, pressure: 'normal' };

const LISBON = {
  question: 'What should I prepare for the Lisbon trip?',
  answer: 'Your itinerary covers three days in Lisbon with a flight on the morning of departure and a hotel near the river.',
  gaps: ['Entry and passport rules for the trip are not stated.', 'Baggage allowance is not given.'],
};

describe('writer prompt', () => {
  test('the inputs are bounded to the design limits and nothing else enters the prompt', () => {
    const bounded = boundConsultWriterInput({
      question: 'q'.repeat(5_000),
      answer: 'a'.repeat(10_000),
      gaps: ['g'.repeat(1_000), 'h', 'i', 'j', 'k', 'l'],
    });
    expect(bounded.question.length).toBe(CONSULT_WRITER_LIMITS.questionChars);
    expect(bounded.answer.length).toBe(CONSULT_WRITER_LIMITS.answerChars);
    expect(bounded.gaps.length).toBe(CONSULT_WRITER_LIMITS.gaps);
    expect(bounded.gaps[0]!.length).toBe(CONSULT_WRITER_LIMITS.gapChars);
    const messages = buildConsultWriterPrompt({ ...LISBON, gaps: [...LISBON.gaps, 'SENTINEL_DOCUMENT_TEXT should never appear'] });
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]!.content).toBe(CONSULT_WRITER_SYSTEM);
    expect(messages[1]!.content).toContain(LISBON.question);
    expect(messages[1]!.content).toContain(LISBON.answer);
    expect(messages[1]!.content).toContain('SENTINEL_DOCUMENT_TEXT');
    expect(Object.isFrozen(messages)).toBe(true);
  });

  test('the rules carry the implied-place rule and the form the gate requires; the schema allows one to three questions or null', () => {
    expect(CONSULT_WRITER_SYSTEM).toMatch(/only implies/);
    expect(CONSULT_WRITER_SYSTEM).toMatch(/a country suggested by a city/);
    expect(CONSULT_WRITER_SYSTEM).toMatch(/never a city or region/);
    expect(CONSULT_WRITER_SYSTEM).toMatch(/at most 25 words/);
    expect(CONSULT_WRITER_SYSTEM).toMatch(/600 bytes and 80 words/);
    expect(CONSULT_WRITER_SYSTEM).toMatch(/\{"questions": null\}/);
    const questions = (CONSULT_WRITER_RESPONSE_SCHEMA as { properties: { questions: { anyOf: unknown[] } } }).properties.questions.anyOf;
    expect(questions).toEqual([
      { type: 'null' },
      { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 200 } },
    ]);
  });

  test('levels: "general" is pinned by hash; "unnamed" has its own; the default is general', () => {
    expect(createHash('sha256').update(CONSULT_WRITER_SYSTEM).digest('hex')).toBe(GENERAL_SYSTEM_SHA256);
    expect(consultWriterSystem('general')).toBe(CONSULT_WRITER_SYSTEM);
    expect(consultWriterSystem('unnamed')).toBe(CONSULT_WRITER_SYSTEM_UNNAMED);
    expect(buildConsultWriterPrompt(LISBON)[0]!.content).toBe(CONSULT_WRITER_SYSTEM);
    expect(buildConsultWriterPrompt(LISBON, 'general')[0]!.content).toBe(CONSULT_WRITER_SYSTEM);
    const unnamed = buildConsultWriterPrompt(LISBON, 'unnamed');
    expect(unnamed[0]!.content).toBe(CONSULT_WRITER_SYSTEM_UNNAMED);
    expect(unnamed[1]!.content).toBe(buildConsultWriterPrompt(LISBON)[1]!.content);
    // Both stay short enough for the built-in writer's 2,048-token bound beside typical inputs.
    expect(CONSULT_WRITER_SYSTEM.length).toBeLessThan(3_800);
    expect(CONSULT_WRITER_SYSTEM_UNNAMED.length).toBeLessThan(3_800);
  });

  test('both levels decide first, never ask about the user\'s documents, and carry several varied shapes instead of one anchoring example (2026-10-10)', () => {
    for (const rules of [CONSULT_WRITER_SYSTEM, CONSULT_WRITER_SYSTEM_UNNAMED]) {
      expect(rules).toMatch(/Decide first/);
      expect(rules).toMatch(/cannot find anything the user's material is missing/);
      expect(rules).toMatch(/deeper reasoning or outside knowledge on top of what the material shows/);
      expect(rules).toMatch(/Never ask what the user's documents say, whether they mention or contain something, or for a document to be shared or uploaded/);
      expect(rules).toMatch(/Shapes, not templates/);
      expect((rules.match(/^- Missing:/gm) ?? []).length).toBeGreaterThanOrEqual(4);
      expect(rules).toMatch(/Propose nothing: only the user's own records hold it/);
      // The single landlord example the live failure copied is gone.
      expect(rules).not.toMatch(/landlord/i);
      expect(rules).not.toMatch(/notary/i);
    }
  });

  test('evidence: only when given, bounded, and placed before the answer', () => {
    const pack = {
      question: 'q',
      candidates: [
        { provenance: { sourceItem: {} as never, citation: { title: 'Letter' } }, trustTier: 'S4', trustDomain: 'secure_local', chunks: ['First chunk.', 'x'.repeat(5_000)] },
        ...Array.from({ length: 20 }, (_, index) => ({ provenance: { sourceItem: {} as never }, trustTier: 'S4', trustDomain: 'secure_local', chunks: [`chunk ${index}`] })),
      ],
      coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] },
      builtAt: 'now',
    } as never;
    const excerpts = consultWriterEvidence(pack);
    expect(excerpts[0]).toBe('Letter: First chunk.');
    expect(excerpts.length).toBe(CONSULT_WRITER_LIMITS.evidenceExcerpts);
    const bounded = boundConsultWriterInput({ ...LISBON, evidence: excerpts });
    expect(bounded.evidence!.length).toBeLessThanOrEqual(CONSULT_WRITER_LIMITS.evidenceExcerpts);
    expect(bounded.evidence![1]!.length).toBe(CONSULT_WRITER_LIMITS.evidenceExcerptChars);
    expect(bounded.evidence!.join('').length).toBeLessThanOrEqual(CONSULT_WRITER_LIMITS.evidenceChars);
    const user = buildConsultWriterPrompt({ ...LISBON, evidence: ['Letter: First chunk.'] }, 'unnamed')[1]!.content;
    expect(user).toContain('[1] Letter: First chunk.');
    expect(user.indexOf('[1] Letter')).toBeLessThan(user.indexOf('Answer:'));
    expect(buildConsultWriterPrompt(LISBON, 'unnamed')[1]!.content).not.toContain('Material the answer read');
  });

  test('the unnamed rules: the situation and a verdict may be sent; what is always removed; what is kept; the combination rule; the same form and reply', () => {
    const rules = CONSULT_WRITER_SYSTEM_UNNAMED;
    expect(rules).toMatch(/ask for a verdict on it/);
    expect(rules).not.toMatch(/gave 45 days' notice/);
    for (const removed of [/names of people, companies, products, projects/, /employers/, /places smaller than a country/, /country only when the answer depends on it/,
      /exact dates and years/, /exact money amounts \(use bands or relative terms/, /about two months' pay/, /account, reference, phone and ID numbers/,
      /file and document titles/, /anything quoted word for word/]) expect(rules).toMatch(removed);
    expect(rules).toMatch(/health, legal, financial and relationship facts/);
    expect(rules).toMatch(/Leave out every detail the answer does not need/);
    expect(rules).toMatch(/Never keep a job, a rare condition and a region together unless the answer needs all three/);
    expect(rules).toMatch(/at most 25 words: at most one short sentence of situation, then a question of at most twelve content words/);
    expect(rules).toMatch(/\{"questions": null\}/);
    // The owner's example fits the form and the parser as written.
    const example = 'A tenant gave 45 days notice where the lease requires 60 days. Can the landlord keep a deposit of about two months rent?';
    expect(parseConsultWriterReply(JSON.stringify({ questions: [example] }))).toEqual({ kind: 'questions', questions: [example] });
  });

});

describe('writer reply', () => {
  test('one to three well-formed questions pass; null declines', () => {
    expect(parseConsultWriterReply('{"questions": ["What passport validity do most countries require from visitors?", "How is cabin baggage usually limited by airlines?"]}'))
      .toEqual({ kind: 'questions', questions: ['What passport validity do most countries require from visitors?', 'How is cabin baggage usually limited by airlines?'] });
    expect(parseConsultWriterReply('{"questions": null}')).toEqual({ kind: 'declined' });
    expect(parseConsultWriterReply('Sure! {"questions": ["What are typical entry rules for short visits?"]} ')).toMatchObject({ kind: 'questions' });
  });

  test('form rules: not JSON, wrong shape, too many, no question mark, too long, multi-line, duplicates', () => {
    expect(parseConsultWriterReply('nothing here')).toEqual({ kind: 'invalid', reason: 'not_json' });
    expect(parseConsultWriterReply('{"consult": ["What is this?"]}')).toEqual({ kind: 'invalid', reason: 'shape' });
    expect(parseConsultWriterReply('{"questions": []}')).toEqual({ kind: 'invalid', reason: 'shape' });
    expect(parseConsultWriterReply('{"questions": ["a?", "b?", "c?", "d?"]}')).toEqual({ kind: 'invalid', reason: 'shape' });
    expect(parseConsultWriterReply('{"questions": ["What are typical entry rules for short visits"]}')).toEqual({ kind: 'invalid', reason: 'form' });
    expect(parseConsultWriterReply('{"questions": ["Is it? Really?"]}')).toEqual({ kind: 'invalid', reason: 'form' });
    expect(parseConsultWriterReply(`{"questions": ["${'word '.repeat(26)}?"]}`)).toEqual({ kind: 'invalid', reason: 'form' });
    expect(parseConsultWriterReply('{"questions": ["What are\\nentry rules for visitors?"]}')).toEqual({ kind: 'invalid', reason: 'form' });
    expect(parseConsultWriterReply('{"questions": ["What are typical entry rules?", "what are typical entry rules?"]}')).toEqual({ kind: 'invalid', reason: 'form' });
  });

  test('the form check is form only: a proper noun is the gate\'s business, not the parser\'s', () => {
    expect(parseConsultWriterReply('{"questions": ["What entry rules apply to visitors arriving in Portugal?"]}')).toMatchObject({ kind: 'questions' });
  });
});

describe('memory rule', () => {
  test('refuses below 20% free after the footprint, at critical pressure and when unknown; warn is allowed (owner decision)', () => {
    expect(consultWriterMemoryDecision(NORMAL)).toMatchObject({ ok: true });
    expect(consultWriterMemoryDecision({ totalBytes: 8 * GB, freePercent: 26, pressure: 'normal' })).toEqual({ ok: false, reason: 'memory_low' });
    // 24 GB: the 0.6 GB footprint is 2.5 points; 22.4% stays above the line, 22.4 does not once rounded down.
    expect(consultWriterMemoryDecision({ totalBytes: 24 * GB, freePercent: 22.6, pressure: 'normal' })).toMatchObject({ ok: true });
    expect(consultWriterMemoryDecision({ totalBytes: 24 * GB, freePercent: 22.4, pressure: 'normal' })).toEqual({ ok: false, reason: 'memory_low' });
    expect(consultWriterMemoryDecision({ ...NORMAL, pressure: 'warn' })).toMatchObject({ ok: true });
    expect(consultWriterMemoryDecision({ ...NORMAL, pressure: 'critical' })).toEqual({ ok: false, reason: 'swap_pressure' });
    expect(consultWriterMemoryDecision({ ...NORMAL, pressure: 'unknown' })).toEqual({ ok: false, reason: 'memory_unknown' });
    expect(consultWriterMemoryDecision(undefined)).toEqual({ ok: false, reason: 'memory_unknown' });
    expect(consultWriterMemoryDecision({ ...NORMAL, freePercent: Number.NaN })).toEqual({ ok: false, reason: 'memory_unknown' });
  });

  test('the macOS probe reads memory_pressure and the kernel pressure level; elsewhere pressure is unknown; a failing probe is undefined', () => {
    const calls: string[] = [];
    const probe = defaultConsultMemoryProbe({
      platform: 'darwin',
      exec: (file, args) => {
        calls.push([file, ...args].join(' '));
        return file.endsWith('memory_pressure') ? 'The system has 2048 pages free.\nSystem-wide memory free percentage: 37%\n' : '2\n';
      },
    });
    expect(probe()).toMatchObject({ freePercent: 37, pressure: 'warn' });
    expect(calls).toEqual(['/usr/bin/memory_pressure', '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level']);
    expect(defaultConsultMemoryProbe({ platform: 'linux', exec: () => { throw new Error('never'); } })()).toMatchObject({ pressure: 'unknown' });
    expect(defaultConsultMemoryProbe({ platform: 'darwin', exec: () => { throw new Error('no tool'); } })()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The writer's own server process

/** A fake llama-server process: records signals; exits on the ones in `exitsOn`. */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  constructor(private readonly exitsOn: readonly NodeJS.Signals[]) {
    super();
  }
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitsOn.includes(signal)) queueMicrotask(() => this.exitNow(signal));
    return true;
  }
  exitNow(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}

interface FakeServerOptions {
  /** The writer's reply text; a function may hang (never resolve) until aborted. */
  reply?: string | ((signal: AbortSignal) => Promise<string>);
  /** Tokens the fake tokenizer reports; undefined makes /tokenize fail (the consult is skipped). */
  tokens?: number | undefined;
  /** /tokenize hangs until its request is aborted. */
  tokenizeHangs?: boolean;
  exitsOn?: NodeJS.Signals[];
}

const servers: ConsultWriterServer[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.kill()));
});

function fakeServer(options: FakeServerOptions = {}) {
  const spawned: FakeChild[] = [];
  const args: string[][] = [];
  const requests: string[] = [];
  const completions: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let alias = '';
  const spawnImpl = ((_command: string, argv: readonly string[], spawnOptions: { env?: Record<string, string> }) => {
    alias = spawnOptions.env?.LLAMA_ARG_ALIAS ?? '';
    args.push([...argv]);
    const child = new FakeChild(options.exitsOn ?? ['SIGKILL']);
    spawned.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === '/health') return new Response('{}');
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: alias }] });
    if (url.pathname === '/apply-template') return Response.json({ prompt: 'templated' });
    if (url.pathname === '/tokenize') {
      if (options.tokenizeHangs) await hang(init?.signal as AbortSignal);
      return options.tokens === undefined ? new Response('no', { status: 500 }) : Response.json({ tokens: new Array(options.tokens).fill(1) });
    }
    if (url.pathname === '/v1/chat/completions') {
      completions.push(JSON.parse(String(init?.body ?? '{}')));
      const reply = options.reply ?? '{"questions": ["What passport validity do most countries require from visitors?"]}';
      const text = typeof reply === 'string' ? reply : await reply(init?.signal as AbortSignal);
      return Response.json({ choices: [{ message: { content: text } }] });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const server = createConsultWriterServer({ serverPath: '/fake/llama-server', modelPath: '/fake/model.gguf', gpu: true }, { spawnImpl, fetchImpl });
  servers.push(server);
  return { server, spawned, args, requests, completions, fetchImpl };
}

/** A completion that never answers until its signal aborts (a hung writer). */
const hang = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

describe('writer server lifecycle', () => {
  test('on demand: the server starts with the answer launcher\'s flags (parallel 1, batch 64, own port), counts tokens, answers, and is killed after the call', async () => {
    const fake = fakeServer({ tokens: 1_500 });
    const outcome = await runConsultWriter(LISBON, { server: fake.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: fake.fetchImpl });
    expect(outcome).toMatchObject({ kind: 'questions', questions: ['What passport validity do most countries require from visitors?'], promptTokens: 1_500 });
    expect(fake.spawned.length).toBe(1);
    const argv = fake.args[0]!;
    expect(argv).toEqual(llamaServerArguments({ serverPath: '/fake/llama-server', modelPath: '/fake/model.gguf', gpu: true, contextTokens: CONSULT_WRITER_LIMITS.contextTokens, threads: Number(argv[argv.indexOf('--threads') + 1]), idleShutdownSeconds: CONSULT_WRITER_LIMITS.idleShutdownSeconds, startupTimeoutMs: 0 }, Number(argv[argv.indexOf('--port') + 1]), argv[argv.indexOf('--api-key-file') + 1]!));
    expect(argv.slice(argv.indexOf('--parallel'), argv.indexOf('--parallel') + 6)).toEqual(['--parallel', '1', '--batch-size', '64', '--ubatch-size', '64']);
    expect(fake.requests.filter((path) => path === '/apply-template' || path === '/tokenize')).toEqual(['/apply-template', '/tokenize']);
    // Stopped with SIGKILL only, never SIGTERM.
    expect(fake.spawned[0]!.signals).toEqual(['SIGKILL']);
    expect(fake.server.pid).toBeUndefined();
  });

  test('the level option selects the rules the model is sent; none is the general level', async () => {
    const unnamed = fakeServer({ tokens: 1_500 });
    await runConsultWriter(LISBON, { server: unnamed.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: unnamed.fetchImpl, level: 'unnamed' });
    expect(unnamed.completions[0]!.messages[0]).toEqual({ role: 'system', content: CONSULT_WRITER_SYSTEM_UNNAMED });
    const general = fakeServer({ tokens: 1_500 });
    await runConsultWriter(LISBON, { server: general.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: general.fetchImpl });
    expect(general.completions[0]!.messages[0]).toEqual({ role: 'system', content: CONSULT_WRITER_SYSTEM });
  });

  test('a fresh answer kills the writer process at once (SIGKILL, no SIGTERM) and the outcome says so', async () => {
    const fake = fakeServer({ tokens: 100, reply: hang });
    const fresh = new AbortController();
    const running = runConsultWriter(LISBON, { server: fake.server, memory: () => NORMAL, kill: fresh.signal, fetchImpl: fake.fetchImpl });
    await waitFor(() => fake.requests.includes('/v1/chat/completions'));
    fresh.abort();
    expect(await running).toEqual({ kind: 'killed', reason: 'fresh_answer' });
    expect(fake.spawned[0]!.signals).toEqual(['SIGKILL']);
  });

  test('a writer that hangs is killed at its deadline', async () => {
    const fake = fakeServer({ tokens: 100, reply: hang });
    const outcome = await runConsultWriter(LISBON, { server: fake.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: fake.fetchImpl, deadlineMs: 60 });
    expect(outcome).toEqual({ kind: 'killed', reason: 'deadline' });
    expect(fake.spawned[0]!.signals).toEqual(['SIGKILL']);
  });

  test('a fresh answer during the tokenizer calls kills the writer process at once; nothing is left on the port', async () => {
    const fake = fakeServer({ tokens: 100, tokenizeHangs: true });
    const fresh = new AbortController();
    const running = runConsultWriter(LISBON, { server: fake.server, memory: () => NORMAL, kill: fresh.signal, fetchImpl: fake.fetchImpl });
    await waitFor(() => fake.requests.includes('/tokenize'));
    fresh.abort();
    expect(await running).toEqual({ kind: 'killed', reason: 'fresh_answer' });
    expect(fake.spawned[0]!.signals).toEqual(['SIGKILL']);
    expect(fake.spawned[0]!.signalCode).toBe('SIGKILL');
    expect(fake.server.pid).toBeUndefined();
    expect(fake.requests).not.toContain('/v1/chat/completions');
  });

  test('the memory rule is enforced before any start: low memory or critical pressure skips the consult and spawns nothing', async () => {
    const fake = fakeServer({ tokens: 100 });
    const kill = new AbortController().signal;
    expect(await runConsultWriter(LISBON, { server: fake.server, memory: () => ({ totalBytes: 8 * GB, freePercent: 25, pressure: 'normal' }), kill, fetchImpl: fake.fetchImpl }))
      .toEqual({ kind: 'skipped', reason: 'memory_low' });
    expect(await runConsultWriter(LISBON, { server: fake.server, memory: () => ({ ...NORMAL, pressure: 'critical' }), kill, fetchImpl: fake.fetchImpl }))
      .toEqual({ kind: 'skipped', reason: 'swap_pressure' });
    expect(await runConsultWriter(LISBON, { server: fake.server, memory: () => { throw new Error('probe broke'); }, kill, fetchImpl: fake.fetchImpl }))
      .toEqual({ kind: 'skipped', reason: 'memory_unknown' });
    expect(fake.spawned.length).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  test('a prompt over 2,048 tokens by the server\'s tokenizer is never sent; without a tokenizer the consult is skipped', async () => {
    const over = fakeServer({ tokens: 2_049 });
    expect(await runConsultWriter(LISBON, { server: over.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: over.fetchImpl }))
      .toEqual({ kind: 'skipped', reason: 'prompt_too_long' });
    expect(over.requests).not.toContain('/v1/chat/completions');
    expect(over.spawned[0]!.signals).toEqual(['SIGKILL']);
    const exact = fakeServer({ tokens: 2_048 });
    expect(await runConsultWriter(LISBON, { server: exact.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: exact.fetchImpl })).toMatchObject({ kind: 'questions', promptTokens: 2_048 });
    // No tokenizer: no estimate stands in; the consult is skipped and the writer is never asked.
    const uncounted = fakeServer({ tokens: undefined });
    expect(await runConsultWriter(LISBON, { server: uncounted.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: uncounted.fetchImpl }))
      .toEqual({ kind: 'skipped', reason: 'prompt_tokens_unavailable' });
    expect(uncounted.requests).not.toContain('/v1/chat/completions');
    expect(uncounted.spawned[0]!.signals).toEqual(['SIGKILL']);
  });

  test('an invalid reply and a decline are reported as such; no runtime means skipped', async () => {
    const invalid = fakeServer({ tokens: 100, reply: 'not json at all' });
    expect(await runConsultWriter(LISBON, { server: invalid.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: invalid.fetchImpl })).toEqual({ kind: 'failed', reason: 'not_json' });
    const declined = fakeServer({ tokens: 100, reply: '{"questions": null}' });
    expect(await runConsultWriter(LISBON, { server: declined.server, memory: () => NORMAL, kill: new AbortController().signal, fetchImpl: declined.fetchImpl })).toMatchObject({ kind: 'declined' });
    expect(await runConsultWriter(LISBON, { server: undefined, memory: () => NORMAL, kill: new AbortController().signal })).toEqual({ kind: 'skipped', reason: 'no_runtime' });
  });
});

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await Bun.sleep(2);
  }
}

describe('the owner\'s own writer (consult.json writer)', () => {
  const ENDPOINT = { baseUrl: 'http://192.168.1.20:8080/v1', model: 'qwen3-32b', apiKey: 'sk-test-not-real' };
  function fakeFetch(replies: Array<{ status: number; body: unknown }>, seen: Array<{ url: string; init: RequestInit }>): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      const reply = replies.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }
  const reply = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }] } });

  test('one chat completion to the chosen address (LAN allowed) with the key, the rules, the evidence and the schema; questions parsed as usual', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await runOwnConsultWriter({ ...LISBON, evidence: ['Itinerary: three days by the river.'] }, {
      endpoint: ENDPOINT,
      kill: new AbortController().signal,
      deadlineMs: 5_000,
      level: 'unnamed',
      fetchImpl: fakeFetch([reply('<think>{"draft": true}</think>{"questions": ["What passport validity do most countries require from short stay visitors?"]}')], seen),
    });
    expect(outcome).toMatchObject({ kind: 'questions', questions: ['What passport validity do most countries require from short stay visitors?'] });
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toBe('http://192.168.1.20:8080/v1/chat/completions');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-not-real');
    expect(seen[0]!.init.redirect).toBe('error');
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.model).toBe('qwen3-32b');
    expect(body.messages[0].content).toBe(CONSULT_WRITER_SYSTEM_UNNAMED);
    expect(body.messages[1].content).toContain('[1] Itinerary: three days by the river.');
    expect(body.response_format.json_schema.schema).toEqual(CONSULT_WRITER_RESPONSE_SCHEMA);
  });

  test('a server that rejects the schema format is asked once more without it; errors and declines are reported; a cloud-tagged model is never asked', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const retried = await runOwnConsultWriter(LISBON, { endpoint: ENDPOINT, kill: new AbortController().signal, deadlineMs: 5_000, fetchImpl: fakeFetch([{ status: 400, body: {} }, reply('{"questions": null}')], seen) });
    expect(retried).toMatchObject({ kind: 'declined' });
    expect(seen.length).toBe(2);
    expect(JSON.parse(String(seen[1]!.init.body)).response_format).toBeUndefined();
    expect(await runOwnConsultWriter(LISBON, { endpoint: ENDPOINT, kill: new AbortController().signal, deadlineMs: 5_000, fetchImpl: fakeFetch([{ status: 500, body: {} }], []) })).toEqual({ kind: 'failed', reason: 'request_failed' });
    expect(await runOwnConsultWriter(LISBON, { endpoint: ENDPOINT, kill: new AbortController().signal, deadlineMs: 5_000, fetchImpl: fakeFetch([reply('no json')], []) })).toEqual({ kind: 'failed', reason: 'not_json' });
    const never: Array<{ url: string; init: RequestInit }> = [];
    expect(await runOwnConsultWriter(LISBON, { endpoint: { ...ENDPOINT, model: 'gpt-oss:120b-cloud' }, kill: new AbortController().signal, deadlineMs: 5_000, fetchImpl: fakeFetch([], never) })).toEqual({ kind: 'skipped', reason: 'cloud_model' });
    expect(never).toEqual([]);
  });

  test('a fresh answer aborts the request at once; a slow server is cut at the deadline', async () => {
    const hanging = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error('aborted'));
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
    const fresh = new AbortController();
    const running = runOwnConsultWriter(LISBON, { endpoint: ENDPOINT, kill: fresh.signal, deadlineMs: 5_000, fetchImpl: hanging });
    fresh.abort();
    expect(await running).toEqual({ kind: 'killed', reason: 'fresh_answer' });
    expect(await runOwnConsultWriter(LISBON, { endpoint: ENDPOINT, kill: new AbortController().signal, deadlineMs: 20, fetchImpl: hanging })).toEqual({ kind: 'killed', reason: 'deadline' });
  });
});
