import { describe, expect, test } from 'bun:test';
import {
  createOpenClawInferAnalystModel,
  OPENCLAW_DEFAULT_MODEL_LABEL,
  OpenClawInferError,
  parseInferOutputText,
  type OpenClawCommandResult,
  type OpenClawCommandRunner,
} from '../src/core/analyst-openclaw-infer.ts';

function fakeRunner(result: Partial<OpenClawCommandResult>): {
  runner: OpenClawCommandRunner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: OpenClawCommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
  return { runner, calls };
}

const OK_JSON = JSON.stringify({
  ok: true,
  capability: 'model.run',
  transport: 'local',
  provider: 'openai',
  model: 'gpt-5.5',
  outputs: [{ text: '{"answer":"synthesized","citations":[],"unanswered":[],"sufficient":true}', mediaUrl: null }],
});

describe('openclaw infer analyst model', () => {
  test('invokes openclaw infer model run with the model, thinking, json, and folded prompt', async () => {
    const { runner, calls } = fakeRunner({ stdout: OK_JSON });
    const model = createOpenClawInferAnalystModel({ runner, command: 'openclaw', model: 'openai/gpt-5.5', thinking: 'high' });

    const completion = await model.complete({ system: 'SYS-RULES', prompt: 'EVIDENCE+QUESTION', localOnly: false });

    expect(completion.modelId).toBe('openai/gpt-5.5');
    expect(completion.text).toContain('synthesized');
    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    expect(command).toBe('openclaw');
    expect(args.slice(0, 5)).toEqual(['infer', 'model', 'run', '--model', 'openai/gpt-5.5']);
    expect(args).toContain('--thinking');
    expect(args).toContain('high');
    expect(args).toContain('--json');
    // the system instructions are folded ahead of the evidence prompt
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt.startsWith('SYS-RULES')).toBe(true);
    expect(prompt).toContain('EVIDENCE+QUESTION');
  });

  test('refuses an oversize prompt before spawning rather than failing execve', async () => {
    const { runner, calls } = fakeRunner({ stdout: OK_JSON });
    const model = createOpenClawInferAnalystModel({ runner });

    // Linux caps a single argv element at 128 KiB; a large evidence pack folded
    // into --prompt reaches that, and an E2BIG spawn failure reads as "could
    // not be spawned" in the audit trail.
    const oversize = 'x'.repeat(200_000);
    await expect(model.complete({ system: 'SYS-RULES', prompt: oversize, localOnly: false }))
      .rejects.toThrow(/too large for the openclaw infer command line/);
    expect(calls).toEqual([]);
  });

  test('parses outputs[0].text from a pretty-printed result with leading noise', () => {
    const noisy = `Doctor warnings ...\nsome banner line\n${JSON.stringify({ ok: true, outputs: [{ text: 'HELLO' }] }, null, 2)}\n`;
    expect(parseInferOutputText(noisy)).toBe('HELLO');
  });

  test('omits --model when no model is configured so OpenClaw uses its default model', async () => {
    const { runner, calls } = fakeRunner({
      stdout: JSON.stringify({ ok: true, provider: 'anthropic', model: 'claude-sonnet-5', outputs: [{ text: 'ANSWER' }] }),
    });
    const model = createOpenClawInferAnalystModel({ runner, command: 'openclaw', thinking: 'low' });

    const completion = await model.complete({ system: 'SYS', prompt: 'P', localOnly: false });

    const { args } = calls[0]!;
    expect(args).not.toContain('--model');
    expect(args.slice(0, 3)).toEqual(['infer', 'model', 'run']);
    expect(args).toContain('--thinking');
    expect(args).toContain('--json');
    // the trace names the model OpenClaw actually resolved
    expect(completion.modelId).toBe('anthropic/claude-sonnet-5');
  });

  test('a blank model is treated as unset, and an unreported default gets a stable label', async () => {
    const { runner, calls } = fakeRunner({ stdout: JSON.stringify({ ok: true, outputs: [{ text: 'A' }] }) });
    const model = createOpenClawInferAnalystModel({ runner, command: 'openclaw', model: '   ' });
    const completion = await model.complete({ system: 's', prompt: 'p', localOnly: false });
    expect(calls[0]!.args).not.toContain('--model');
    expect(completion.modelId).toBe(OPENCLAW_DEFAULT_MODEL_LABEL);
  });

  test('a non-zero exit surfaces a bounded reason with OpenClaw\'s own error line', async () => {
    const { runner } = fakeRunner({
      code: 1,
      stderr: '\n[infer] Error: No API key found for provider "openai" (model openai/gpt-5.5)\nstack line 2\n',
    });
    const model = createOpenClawInferAnalystModel({ runner, command: 'openclaw', model: 'openai/gpt-5.5' });
    const failure = await model.complete({ system: 's', prompt: 'p', localOnly: false }).catch((error) => error);

    expect(failure).toBeInstanceOf(OpenClawInferError);
    expect(failure.message).toBe(
      'OpenClaw inference failed (exit 1, model openai/gpt-5.5): [infer] Error: No API key found for provider "openai" (model openai/gpt-5.5).',
    );
    expect(failure.safeReason).toBe(failure.message);
    expect(failure.message).not.toContain('stack line 2');
    expect(failure.suggestion).toContain('remove the explicit analyst model');
  });

  test('the --json failure envelope code and message are preferred over stderr', async () => {
    const { runner } = fakeRunner({
      code: 1,
      stdout: JSON.stringify({ ok: false, error: { code: 'auth_missing', message: 'model has no configured auth' } }),
      stderr: 'noise',
    });
    const model = createOpenClawInferAnalystModel({ runner, command: 'openclaw' });
    await expect(model.complete({ system: 's', prompt: 'p', localOnly: false })).rejects.toThrow(
      'OpenClaw inference failed (exit 1, model OpenClaw default model): auth_missing: model has no configured auth.',
    );
  });

  test('failure detail redacts secrets, truncates, and never echoes prompt or evidence', async () => {
    const evidence = 'PRIVATE-EVIDENCE: the quarterly numbers for the acquisition target were 42';
    const echo = fakeRunner({ code: 2, stderr: `bad request: ${evidence}` });
    const echoed = await createOpenClawInferAnalystModel({ runner: echo.runner, command: 'openclaw' })
      .complete({ system: 's', prompt: evidence, localOnly: false })
      .catch((error) => error);
    expect(echoed.message).not.toContain('PRIVATE-EVIDENCE');
    expect(echoed.message).toContain('detail withheld');

    const secret = fakeRunner({
      code: 1,
      stderr: `auth failed api_key=sk-live-abcdefghijklmnop1234 Bearer abc.def.ghi token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc ${'x'.repeat(400)}`,
    });
    const redacted = await createOpenClawInferAnalystModel({ runner: secret.runner, command: 'openclaw' })
      .complete({ system: 's', prompt: 'p', localOnly: false })
      .catch((error) => error);
    expect(redacted.message).not.toContain('sk-live');
    expect(redacted.message).not.toContain('abc.def.ghi');
    expect(redacted.message).not.toContain('9f8e7d6c5b4a');
    expect(redacted.message).toContain('<redacted>');
    expect(redacted.message.length).toBeLessThan(300);
  });

  test('a missing openclaw executable reads as "not found on the worker PATH"', async () => {
    const runner: OpenClawCommandRunner = {
      async run() {
        const error = new Error('Executable not found in $PATH: "openclaw"') as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      },
    };
    const model = createOpenClawInferAnalystModel({ runner, command: 'openclaw' });
    const failure = await model.complete({ system: 's', prompt: 'p', localOnly: false }).catch((error) => error);
    expect(failure).toBeInstanceOf(OpenClawInferError);
    expect(failure.message).toBe('OpenClaw CLI not found on the worker PATH (openclaw).');
    expect(failure.suggestion).toContain('OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND');
  });

  test('the real spawn runner maps an absent absolute command to the same reason', async () => {
    const model = createOpenClawInferAnalystModel({ command: '/nonexistent/olympus-test/openclaw' });
    await expect(model.complete({ system: 's', prompt: 'p', localOnly: false })).rejects.toThrow(
      'OpenClaw CLI not found on the worker PATH (openclaw).',
    );
  });

  test('throws on ok=false', () => {
    expect(() => parseInferOutputText(JSON.stringify({ ok: false, outputs: [{ text: 'x' }] }))).toThrow(/ok=false/);
  });

  test('throws when outputs are missing or malformed', () => {
    expect(() => parseInferOutputText(JSON.stringify({ ok: true }))).toThrow(/no outputs/);
    expect(() => parseInferOutputText(JSON.stringify({ ok: true, outputs: [{}] }))).toThrow(/not a string/);
    expect(() => parseInferOutputText('not json at all')).toThrow(/no JSON object/);
  });
});
