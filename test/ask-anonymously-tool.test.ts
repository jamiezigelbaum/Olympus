// The `ask_anonymously` lane end to end, without zkAPI: the operation posts
// to the worker's /consult/ask route through the EmailClient, the worker
// validates shapes and hands the core's outcome back as a result (refusals
// included), the surfaces render it (owner decision 2026-10-10: agent-first
// anonymous answers).
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { SourceAnswerJobRegistry } from '../src/core/source-answer-jobs.ts';
import { createEmailSourceWorker, type ConsultAskWireRequest } from '../src/workers/email-source/index.ts';
import { askAnonymouslyToolResult, isAskAnonymouslyResult } from '../src/workers/chatgpt/response-builder.ts';

const ask = operations.find((operation) => operation.name === 'ask_anonymously')!;

function lane(consultAsk?: (input: ConsultAskWireRequest, signal: AbortSignal) => Promise<unknown>) {
  const worker = createEmailSourceWorker(consultAsk ? { consultAsk } : {});
  const config = defaultConfig();
  config.email.enabled = true;
  const email = new EmailClient(config, new DirectHttpEmailTransport((input, init) => worker.fetch(new Request(input, init))));
  const ctx: OperationContext = { config, delphi: {} as OperationContext['delphi'], email };
  return { worker, ctx };
}

describe('ask_anonymously: operation → worker route → core', () => {
  test('the question and the conversation\'s choices reach the core exactly; the outcome comes back as a result, refusals included', async () => {
    const seen: ConsultAskWireRequest[] = [];
    const { ctx } = lane(async (input) => {
      seen.push(input);
      if (input.level === undefined) return { ok: false, code: 'needs_choice', message: 'Ask the user once.', options: { suggestedLevel: 'standard', suggestedCleanup: 'as_written', customInstruction: false } };
      return { ok: true, sent: input.question, reply: 'Usually two weeks.', route: 'zkAPI via Tor', level: input.level, cleanup: 'as_written', rewritten: false, remembered: input.remember === true };
    });
    expect(await ask.handler(ctx, { question: 'How long do deposits take?' })).toMatchObject({ ok: false, code: 'needs_choice' });
    expect(await ask.handler(ctx, { question: 'How long do deposits take?', level: 'standard', cleanup: 'as_written', remember: true, model: 'anthropic/claude-sonnet-5.5' }))
      .toMatchObject({ ok: true, reply: 'Usually two weeks.', level: 'standard', remembered: true });
    expect(seen).toEqual([
      { question: 'How long do deposits take?' },
      { question: 'How long do deposits take?', level: 'standard', cleanup: 'as_written', remember: true, model: 'anthropic/claude-sonnet-5.5' },
    ]);
  });

  test('the calling agent rides to the core with its hosting provider; a connection claim from outside the remote endpoint is refused', async () => {
    const seen: ConsultAskWireRequest[] = [];
    const { ctx, worker } = lane(async (input) => { seen.push(input); return { ok: true, sent: input.question, reply: 'r', route: 'zkAPI via Tor', level: 'standard', rewritten: false, remembered: false, model: 'openai/gpt-5.5' }; });
    expect(await ask.handler({ ...ctx, caller: { surface: 'mcp', displayName: 'claude-code', provider: 'anthropic' } }, { question: 'Q?' })).toMatchObject({ ok: true, model: 'openai/gpt-5.5' });
    expect(seen).toEqual([{ question: 'Q?', caller: { surface: 'mcp', display_name: 'claude-code', provider: 'anthropic' } }]);
    const forged = await worker.fetch(new Request('http://worker.test/v1/consult/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q?', caller: { surface: 'remote', connection_id: 'conn_1', provider: 'openai' } }),
    }));
    expect(forged.status).toBe(400);
    expect(seen).toHaveLength(1);
  });

  test('bad shapes are refused before the worker: unknown params, a wrong level or cleanup, a non-boolean remember', async () => {
    const { ctx } = lane(async () => { throw new Error('must not be called'); });
    await expect(ask.handler(ctx, { question: 'x', level: 'loose' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(ask.handler(ctx, { question: 'x', cleanup: 'tidy' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(ask.handler(ctx, { question: 'x', remember: 'maybe' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(ask.handler(ctx, { question: 'x', documents: true })).rejects.toThrow('undeclared property: "documents"');
    await expect(ask.handler(ctx, {})).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('the worker route validates its body and answers 501 when the composition root bound no Ask', async () => {
    const unbound = lane();
    const post = (worker: typeof unbound.worker, body: string) => worker.fetch(new Request('http://worker.test/v1/consult/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
    expect((await post(unbound.worker, JSON.stringify({ question: 'x' }))).status).toBe(501);
    const bound = lane(async () => ({ ok: true, sent: 'x', reply: 'y', route: 'r', level: 'standard', rewritten: false, remembered: false }));
    for (const body of ['{}', '{"question": ""}', '{"question": "x", "level": "loose"}', '{"question": "x", "cleanup": "tidy"}', '{"question": "x", "remember": "yes"}']) {
      const response = await post(bound.worker, body);
      expect([body, response.status]).toEqual([body, 400]);
    }
    const ok = await post(bound.worker, JSON.stringify({ question: 'x', level: 'standard' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, reply: 'y' });
  });

  test('a native host\'s cancellation (no job hand-off) reaches the worker request', async () => {
    let seen: AbortSignal | undefined;
    const { ctx } = lane(async (_input, signal) => { seen = signal; return { ok: false, code: 'cancelled', message: 'cancelled' }; });
    const controller = new AbortController();
    await ask.handler({ ...ctx, signal: controller.signal }, { question: 'x', level: 'standard' });
    expect(seen!.aborted).toBe(false);
    controller.abort();
    expect(seen!.aborted).toBe(true);
  });

  test('with a job registry (stdio MCP), the caller\'s cancellation ends the ask until hand-off and not after', async () => {
    const seen: AbortSignal[] = [];
    const { ctx } = lane(async (_input, signal) => {
      seen.push(signal);
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { ok: false, code: 'cancelled', message: 'cancelled' };
    });
    // Before hand-off: the caller's abort reaches the worker request.
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 60_000, resultWaitMs: 1_000, deadlineMs: 60_000, ttlMs: 60_000, maxRunningGlobal: 2, maxRunningPerOwner: 2, maxRetainedPerOwner: 4, maxResultBytes: 1_000_000 } });
    const caller = new AbortController();
    const early = ask.handler({ ...ctx, signal: caller.signal, sourceAnswerJobs: { registry, owner: 'o' } }, { question: 'x', level: 'standard' });
    await Bun.sleep(5);
    caller.abort();
    expect(await early).toMatchObject({ ok: false, code: 'cancelled' });
    expect(seen[0]!.aborted).toBe(true);
    // After hand-off: the caller may go; the work keeps its own signal.
    const quick = new SourceAnswerJobRegistry({ limits: { handoffMs: 5, resultWaitMs: 1_000, deadlineMs: 60_000, ttlMs: 60_000, maxRunningGlobal: 2, maxRunningPerOwner: 2, maxRetainedPerOwner: 4, maxResultBytes: 1_000_000 } });
    const late = new AbortController();
    const handed = await ask.handler({ ...ctx, signal: late.signal, sourceAnswerJobs: { registry: quick, owner: 'o' } }, { question: 'x', level: 'standard' });
    expect(handed).toMatchObject({ status: 'working' });
    late.abort();
    await Bun.sleep(5);
    expect(seen[1]!.aborted).toBe(false);
  });

  test('the caller\'s cancellation reaches the core through the client and the route', async () => {
    let seen: AbortSignal | undefined;
    const { ctx } = lane(async (_input, signal) => { seen = signal; return { ok: false, code: 'cancelled', message: 'cancelled' }; });
    const controller = new AbortController();
    await ctx.email.askAnonymously({ question: 'x', level: 'standard', signal: controller.signal });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    controller.abort();
    expect(seen!.aborted).toBe(true);
  });

  test('off the Gateway the ask waits for the whole session (20 min ceiling); inside OpenClaw the lane keeps its 10-minute ceiling', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const email = { askAnonymously: async (options: Record<string, unknown>) => { calls.push(options); return { ok: true }; } } as unknown as OperationContext['email'];
    const base: OperationContext = { config: defaultConfig(), delphi: {} as OperationContext['delphi'], email };
    await ask.handler({ ...base, caller: { surface: 'mcp' } }, { question: 'x' });
    await ask.handler({ ...base, caller: { surface: 'remote', connectionId: 'c', displayName: 'Muse' } }, { question: 'x' });
    await ask.handler(base, { question: 'x' });
    await ask.handler({ ...base, caller: { surface: 'native', displayName: 'OpenClaw' } }, { question: 'x', timeoutMs: 1_200_000 });
    expect(calls.map((call) => call.maxTimeoutMs)).toEqual([1_200_000, 1_200_000, 1_200_000, undefined]);
    expect(calls[3]!.timeoutMs).toBe(1_200_000);
  });

  test('a disabled worker refuses with email_not_configured before any request', async () => {
    const { ctx } = lane(async () => { throw new Error('must not be called'); });
    ctx.config.email.enabled = false;
    await expect(ask.handler(ctx, { question: 'x' })).rejects.toMatchObject({ code: 'email_not_configured' });
  });

  test('the operation is on every agent surface and the CLI: not read-only (it spends and sends out), open-world, always exposed natively, `olympus ask`', () => {
    expect(ask.mutating).toBe(true);
    expect(ask.openWorld).toBe(true);
    expect(ask.nativeExposure).toBe('always');
    expect(ask.cliHints).toEqual({ name: 'ask', positional: ['question'], stdin: 'question' });
    expect(Object.keys(ask.params)).toEqual(['question', 'level', 'cleanup', 'remember', 'model', 'timeoutMs']);
    // The collector is exposed wherever the ask can hand off, source index on or off.
    expect(operations.find((operation) => operation.name === 'source_answer_result')?.nativeExposure).toBe('always');
  });
});

describe('ask_anonymously: the ChatGPT result', () => {
  test('an answer carries the reply, how it was asked and what was sent; a rewrite tells the model to say so', () => {
    const rewritten = askAnonymouslyToolResult({ ok: true, sent: 'How long do deposits take?', reply: 'Two weeks.', route: 'zkAPI via Tor', networkIdentity: 'hidden', level: 'strict', rewritten: true, remembered: true });
    expect(rewritten.structuredContent).toEqual({ status: 'answered', answer: 'Two weeks.', anonymous: true, route: 'zkAPI via Tor', level: 'strict', rewritten: true, sent: 'How long do deposits take?', remembered: true });
    expect(rewritten.content[0]!.text).toContain('Two weeks.');
    expect(rewritten.content[0]!.text).toContain('rewrote the question');
    expect(rewritten.isError).toBeUndefined();
    const plain = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y\u0007', route: 'r', networkIdentity: 'hidden', level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false });
    expect(plain.structuredContent).toEqual({ status: 'answered', answer: 'y', anonymous: true, route: 'r', level: 'standard', rewritten: false, sent: 'x', cleanup: 'as_written' });
    expect(plain.content[0]!.text).toContain('Asked anonymously');
    expect(plain.content[0]!.text).toContain('as written');
    // Tor off: never called anonymous; the model is told the address was visible.
    const exposed = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y', route: 'zkAPI, payment privacy only (network address visible)', networkIdentity: 'visible', level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false });
    expect(exposed.structuredContent).toMatchObject({ status: 'answered', anonymous: false, network_address: 'visible' });
    expect(exposed.content[0]!.text).not.toContain('anonymously');
    expect(exposed.content[0]!.text).toContain('network address visible');
    // Tor ran but the route could not be verified (no confinement on Linux): neither anonymous nor "Tor off"; the route says why.
    const unverified = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y', route: 'payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified; no confinement', networkIdentity: 'not_verified', level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false });
    expect(unverified.structuredContent).toMatchObject({ status: 'answered', anonymous: false, network_address: 'not_verified' });
    expect(unverified.content[0]!.text).not.toContain('anonymously');
    expect(unverified.content[0]!.text).not.toContain('Tor is off');
    expect(unverified.content[0]!.text).toContain('network route not verified');
    expect(unverified.content[0]!.text).toContain('actual route is not verified');
    // A requested save that failed is told with the answer.
    const unsaved = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y', route: 'r', level: 'standard', rewritten: false, remembered: false, note: 'Not saved; choose again next time.' });
    expect(unsaved.structuredContent).toMatchObject({ status: 'answered', note: 'Not saved; choose again next time.' });
    expect(unsaved.content[0]!.text).toContain('Tell the user: Not saved; choose again next time.');
    // The answering model is named, so the agent can say which provider read the question.
    const named = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y', route: 'r', networkIdentity: 'hidden', level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false, model: 'anthropic/claude-sonnet-5.5' });
    expect(named.structuredContent).toMatchObject({ status: 'answered', model: 'anthropic/claude-sonnet-5.5' });
    expect(named.content[0]!.text).toContain('Answered by anthropic/claude-sonnet-5.5.');
  });

  test('needs_choice and refusals are results in the user\'s words, never errors; working hands off to source_answer_result', () => {
    const choice = askAnonymouslyToolResult({ ok: false, code: 'needs_choice', message: 'Ask once.', options: { suggestedLevel: 'strict', suggestedCleanup: 'custom', customInstruction: true } });
    expect(choice.structuredContent).toEqual({ status: 'needs_choice', message: 'Ask once.', options: { suggested_level: 'strict', suggested_cleanup: 'custom', custom_instruction: true } });
    expect(choice.isError).toBeUndefined();
    const refused = askAnonymouslyToolResult({ ok: false, code: 'secret_detected', message: 'Not sent: a key.', sent: 'secret text' });
    expect(refused.structuredContent).toEqual({ status: 'refused', code: 'secret_detected', message: 'Not sent: a key.' });
    expect(JSON.stringify(refused)).not.toContain('secret text');
    // A send that failed after the question left: the model is told it may have been charged (Codex P1 on #227), still without the text.
    const failed = askAnonymouslyToolResult({ ok: false, code: 'session_spent', message: 'The session ended before a reply.', sent: 'what left', outcome: 'sent_failed' });
    expect(failed.structuredContent).toMatchObject({ status: 'refused', code: 'session_spent', outcome: 'sent_failed' });
    expect(String((failed.structuredContent as Record<string, unknown>).note)).toContain('may have been charged');
    expect(JSON.stringify(failed)).not.toContain('what left');
    expect(askAnonymouslyToolResult({ ok: false, code: 'busy', message: 'm', sent: 's', outcome: 'not_sent' }).structuredContent).toEqual({ status: 'refused', code: 'busy', message: 'm' });
    const working = askAnonymouslyToolResult({ status: 'working', job_id: 'saj_abc' });
    expect(working.structuredContent).toEqual({ status: 'working', job_id: 'saj_abc', next_tool: 'source_answer_result' });
    expect(askAnonymouslyToolResult({ nonsense: true }).isError).toBe(true);
  });

  test('an ask result is told apart from a source answer by shape, so a collected job renders the right way', () => {
    expect(isAskAnonymouslyResult({ ok: true, reply: 'y', sent: 'x' })).toBe(true);
    expect(isAskAnonymouslyResult({ ok: false, code: 'needs_choice', message: 'm' })).toBe(true);
    expect(isAskAnonymouslyResult({ answer: 'text', evidence: [] })).toBe(false);
    expect(isAskAnonymouslyResult({ status: 'working', job_id: 'saj_x' })).toBe(false);
    expect(isAskAnonymouslyResult(null)).toBe(false);
  });
});
