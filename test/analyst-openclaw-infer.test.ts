import { describe, expect, test } from 'bun:test';
import {
  createOpenClawInferAnalystModel,
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

  test('throws when the CLI exits non-zero (handler then falls back to local)', async () => {
    const { runner } = fakeRunner({ code: 1, stderr: 'auth failed' });
    const model = createOpenClawInferAnalystModel({ runner });
    await expect(model.complete({ system: 's', prompt: 'p', localOnly: false })).rejects.toThrow(/exited with code 1/);
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
