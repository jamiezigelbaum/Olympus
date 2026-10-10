// The `ask_anonymously` lane end to end, without zkAPI: the operation posts
// to the worker's /consult/ask route through the EmailClient, the worker
// validates shapes and hands the core's outcome back as a result (refusals
// included), the surfaces render it (owner decision 2026-10-10: agent-first
// anonymous answers).
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
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
    expect(Object.keys(ask.params)).toEqual(['question', 'level', 'cleanup', 'remember', 'model']);
  });
});

describe('ask_anonymously: the ChatGPT result', () => {
  test('an answer carries the reply, how it was asked and what was sent; a rewrite tells the model to say so', () => {
    const rewritten = askAnonymouslyToolResult({ ok: true, sent: 'How long do deposits take?', reply: 'Two weeks.', route: 'zkAPI via Tor', level: 'strict', rewritten: true, remembered: true });
    expect(rewritten.structuredContent).toEqual({ status: 'answered', answer: 'Two weeks.', anonymous: true, level: 'strict', rewritten: true, sent: 'How long do deposits take?', remembered: true });
    expect(rewritten.content[0]!.text).toContain('Two weeks.');
    expect(rewritten.content[0]!.text).toContain('rewrote the question');
    expect(rewritten.isError).toBeUndefined();
    const plain = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y\u0007', route: 'r', level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false });
    expect(plain.structuredContent).toEqual({ status: 'answered', answer: 'y', anonymous: true, level: 'standard', rewritten: false, sent: 'x', cleanup: 'as_written' });
    expect(plain.content[0]!.text).toContain('as written');
    // A requested save that failed is told with the answer.
    const unsaved = askAnonymouslyToolResult({ ok: true, sent: 'x', reply: 'y', route: 'r', level: 'standard', rewritten: false, remembered: false, note: 'Not saved; choose again next time.' });
    expect(unsaved.structuredContent).toMatchObject({ status: 'answered', note: 'Not saved; choose again next time.' });
    expect(unsaved.content[0]!.text).toContain('Tell the user: Not saved; choose again next time.');
  });

  test('needs_choice and refusals are results in the user\'s words, never errors; working hands off to source_answer_result', () => {
    const choice = askAnonymouslyToolResult({ ok: false, code: 'needs_choice', message: 'Ask once.', options: { suggestedLevel: 'strict', suggestedCleanup: 'custom', customInstruction: true } });
    expect(choice.structuredContent).toEqual({ status: 'needs_choice', message: 'Ask once.', options: { suggested_level: 'strict', suggested_cleanup: 'custom', custom_instruction: true } });
    expect(choice.isError).toBeUndefined();
    const refused = askAnonymouslyToolResult({ ok: false, code: 'secret_detected', message: 'Not sent: a key.', sent: 'secret text' });
    expect(refused.structuredContent).toEqual({ status: 'refused', code: 'secret_detected', message: 'Not sent: a key.' });
    expect(JSON.stringify(refused)).not.toContain('secret text');
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
