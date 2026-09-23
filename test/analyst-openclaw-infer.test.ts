import { describe, expect, test } from 'bun:test';
import {
  createOpenClawInferAnalystModel,
  OPENCLAW_DEFAULT_MODEL_LABEL,
  OpenClawInferError,
  echoesEvidence,
  parseInferOutputText,
  safeInferDetail,
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

  test('known failure classes get fixed messages that carry no OpenClaw text', async () => {
    const fail = async (result: Partial<OpenClawCommandResult>, explicitModel?: string) => {
      const { runner } = fakeRunner(result);
      return createOpenClawInferAnalystModel({ runner, command: 'openclaw', ...(explicitModel ? { model: explicitModel } : {}) })
        .complete({ system: 's', prompt: 'p', localOnly: false })
        .catch((error) => error);
    };

    const auth = await fail({ code: 1, stderr: '[infer] Error: No API key found for provider "openai"\nstack\n' }, 'openai/gpt-5.5');
    expect(auth).toBeInstanceOf(OpenClawInferError);
    expect(auth.message).toBe('OpenClaw inference failed (exit 1, model openai/gpt-5.5): no usable auth for model openai/gpt-5.5.');
    expect(auth.safeReason).toBe(auth.message);
    expect(auth.suggestion).toContain('remove the explicit analyst model');

    const envelope = await fail({
      code: 1,
      stdout: JSON.stringify({ ok: false, error: { code: 'auth_missing', message: 'model has no configured auth' } }),
    });
    expect(envelope.message).toBe(
      'OpenClaw inference failed (exit 1, model OpenClaw default model): no usable auth for model OpenClaw default model.',
    );

    const unknownModel = await fail({ code: 1, stderr: 'Unknown model: openai/gpt-9' }, 'openai/gpt-9');
    expect(unknownModel.message).toContain(': OpenClaw does not recognize model openai/gpt-9.');

    const killed = await fail({ code: 143, stderr: '' });
    expect(killed.message).toContain('(exit 143, model OpenClaw default model): the run was terminated');

    const codeOnly = await fail({ code: 2, stdout: JSON.stringify({ ok: false, error: { code: 'gateway_unavailable', message: 'x' } }) });
    expect(codeOnly.message).toBe('OpenClaw inference failed (exit 2, model OpenClaw default model): OpenClaw error gateway_unavailable.');
  });

  test('unclassified free text is redacted and bounded', async () => {
    const { runner } = fakeRunner({
      code: 1,
      stderr: `upstream refused: Bearer abc.def.ghi token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc sk-live-abcdefghijklmnop1234 ${'x'.repeat(400)}`,
    });
    const failure = await createOpenClawInferAnalystModel({ runner, command: 'openclaw' })
      .complete({ system: 's', prompt: 'the notes mention a garden party', localOnly: false })
      .catch((error) => error);
    expect(failure.message).toStartWith('OpenClaw inference failed (exit 1, model OpenClaw default model): upstream refused:');
    expect(failure.message).not.toContain('abc.def.ghi');
    expect(failure.message).not.toContain('9f8e7d6c5b4a');
    expect(failure.message).not.toContain('sk-live');
    expect(failure.message).toContain('<redacted>');
    expect(failure.message.length).toBeLessThan(300);
  });

  describe('free text that echoes the request is withheld', () => {
    const evidence = [
      'Question: what did my notes say?',
      'Evidence [1]: Patient\tSSN 123-45-6789\tflagged for review;  quarterly  numbers  were  42 million.',
    ].join('\n');
    const leakCases: Array<[string, string]> = [
      ['tab-separated echo', 'bad request: Patient\tSSN 123-45-6789\tflagged'],
      ['double-spaced echo', 'bad request near "quarterly  numbers  were  42"'],
      ['short quoted echo', "flagged 'SSN 123-45-6789' in input"],
      ['JSON-escaped stderr echo', String.raw`{"level":"error","msg":"invalid input: Patient\tSSN 123-45-6789\tflagged"}`],
      ['JSON-escaped double-spaced echo', String.raw`error: \"quarterly  numbers  were  42 million\"`],
      ['case and punctuation changes', 'ERROR: QUARTERLY-NUMBERS-WERE-42'],
    ];
    for (const [name, stderr] of leakCases) {
      test(name, async () => {
        const { runner } = fakeRunner({ code: 1, stderr });
        const failure = await createOpenClawInferAnalystModel({ runner, command: 'openclaw' })
          .complete({ system: 'SYSTEM RULES', prompt: evidence, localOnly: false })
          .catch((error) => error);
        expect(failure).toBeInstanceOf(OpenClawInferError);
        expect(failure.message).toContain('detail withheld because it echoed request content');
        for (const fragment of ['123-45-6789', '6789', 'quarterly', 'Patient', 'SSN']) {
          expect(failure.message).not.toContain(fragment);
        }
      });
    }

    test('an envelope error code that echoes evidence is not surfaced as a code', async () => {
      const { runner } = fakeRunner({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'Patient-SSN-123' } }) });
      const failure = await createOpenClawInferAnalystModel({ runner, command: 'openclaw' })
        .complete({ system: 's', prompt: evidence, localOnly: false })
        .catch((error) => error);
      expect(failure.message).not.toContain('Patient');
    });
  });

  test('echo detection normalizes whitespace, case, punctuation, and JSON escapes', () => {
    expect(echoesEvidence('SSN\t123-45-6789', 'the ssn 123 45 6789 is private')).toBe(true);
    expect(echoesEvidence(String.raw`a\tb\nc`, 'A B C')).toBe(true);
    expect(echoesEvidence('connection reset by gateway', 'the notes mention a garden party')).toBe(false);
    expect(safeInferDetail('connection reset by gateway\nsecond line', 'the notes mention a garden party'))
      .toBe('connection reset by gateway');
  });

  test('only a spawn ENOENT code counts as not found; other spawn errors surface only their code', async () => {
    const runner: OpenClawCommandRunner = {
      async run() {
        const error = new Error('spawn failed: no such file or directory while passing argv PRIVATE-EVIDENCE') as Error & { code: string };
        error.code = 'E2BIG';
        throw error;
      },
    };
    const failure = await createOpenClawInferAnalystModel({ runner, command: 'openclaw' })
      .complete({ system: 's', prompt: 'PRIVATE-EVIDENCE', localOnly: false })
      .catch((error) => error);
    expect(failure.message).toBe('OpenClaw inference could not start (model OpenClaw default model): E2BIG.');
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
