// OLYMPUS_TEST_LANE: deploy
// The xAI agent loop (against a fake provider) and the credential command.

import { describe, expect, test } from 'bun:test';
import { AGENT_INSTRUCTIONS, AgentApiError, readAgentKey, runXaiAgent, type AgentSpec, type ToolBridge } from '../scripts/release-check/agents.ts';

const spec: AgentSpec = { id: 'xai', label: 'Grok', kind: 'xai-api', model: 'test-model' };
const tools = [{ name: 'olympus_search', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }];

interface Sent { url: string; headers: Record<string, string>; body: any }

function fakeProvider(replies: Array<Record<string, unknown> | { status: number; body: string }>) {
  const sent: Sent[] = [];
  let next = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const reply = replies[Math.min(next, replies.length - 1)]!;
    next += 1;
    if ('status' in reply) return new Response(String(reply.body), { status: Number(reply.status) });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { fetch, sent };
}

const bridge = (log: Array<{ name: string; args: Record<string, unknown> }> = []): ToolBridge => ({
  async call(name, args) {
    log.push({ name, args });
    return { text: 'Evidence [E1]: the club meets on 24 October.', isError: false };
  },
});

describe('xAI agent loop', () => {
  test('runs a function-tool turn, answers, and counts every request and token', async () => {
    const provider = fakeProvider([
      { id: 'r1', usage: { input_tokens: 100, output_tokens: 10 }, output: [{ type: 'function_call', name: 'olympus_search', call_id: 'c1', arguments: '{"query":"club"}' }] },
      { id: 'r2', usage: { input_tokens: 150, output_tokens: 25 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'It meets on 24 October [E1].' }] }] },
    ]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transcript = await runXaiAgent(spec, 'secret-key', 'When does the club meet?', tools, bridge(calls), { fetch: provider.fetch });
    expect(transcript.finalText).toBe('It meets on 24 October [E1].');
    expect(transcript.usage).toEqual({ calls: 2, inputTokens: 250, outputTokens: 35 });
    expect(calls).toEqual([{ name: 'olympus_search', args: { query: 'club' } }]);
    expect(transcript.calls[0]?.output.text).toContain('24 October');

    const [first, second] = provider.sent;
    expect(first?.url).toBe('https://api.x.ai/v1/responses');
    expect(first?.headers.authorization).toBe('Bearer secret-key');
    expect(first?.body.model).toBe('test-model');
    expect(first?.body.instructions).toBe(AGENT_INSTRUCTIONS);
    // Only the engine's tools are offered: never a web or X search tool.
    expect(first?.body.tools).toEqual([{ type: 'function', name: 'olympus_search', description: 'search', parameters: tools[0]!.inputSchema }]);
    expect(first?.body.previous_response_id).toBeUndefined();
    expect(second?.body.previous_response_id).toBe('r1');
    // The provider refuses instructions together with a previous response id.
    expect(second?.body.instructions).toBeUndefined();
    expect(second?.body.input).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'Evidence [E1]: the club meets on 24 October.' }]);
  });

  test('tolerates malformed tool arguments by calling with none', async () => {
    const provider = fakeProvider([
      { id: 'r1', output: [{ type: 'function_call', name: 'olympus_search', call_id: 'c1', arguments: 'not json' }] },
      { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] },
    ]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transcript = await runXaiAgent(spec, 'k', 'q', tools, bridge(calls), { fetch: provider.fetch });
    expect(calls[0]?.args).toEqual({});
    expect(transcript.usage.calls).toBe(2);
  });

  test('stops after a bounded number of turns when the model keeps calling tools', async () => {
    const looping = { id: 'r', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'function_call', name: 'olympus_search', call_id: 'c', arguments: '{}' }] };
    const provider = fakeProvider([looping]);
    const transcript = await runXaiAgent(spec, 'k', 'q', tools, bridge(), { fetch: provider.fetch });
    expect(transcript.usage.calls).toBe(6);
    expect(transcript.finalText).toBe('');
  });

  test('a provider error names the status and error type but never echoes the body', async () => {
    const provider = fakeProvider([{ status: 401, body: JSON.stringify({ error: { type: 'invalid_api_key', message: 'Bearer secret-key was rejected' } }) }]);
    const error = await runXaiAgent(spec, 'secret-key', 'q', tools, bridge(), { fetch: provider.fetch }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('provider answered 401 (invalid_api_key)');
    expect((error as Error).message).not.toContain('secret-key');
  });
});

describe('xAI agent failures', () => {
  test('a failure on a later turn keeps the calls and tokens already used', async () => {
    const provider = fakeProvider([
      { id: 'r1', usage: { input_tokens: 100, output_tokens: 10 }, output: [{ type: 'function_call', name: 'olympus_search', call_id: 'c1', arguments: '{}' }] },
      { status: 400, body: JSON.stringify({ code: '400', error: 'rejected' }) },
    ]);
    const error = await runXaiAgent(spec, 'k', 'q', tools, bridge(), { fetch: provider.fetch }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(AgentApiError);
    const failure = error as AgentApiError;
    expect(failure.message).toBe('provider answered 400 (rejected)');
    expect(failure.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 10 });
    expect(failure.calls).toHaveLength(1);
  });
});

describe('credential command', () => {
  test('returns the trimmed value the command prints', async () => {
    expect(await readAgentKey({ keyCommand: ['printf', '  token-value\n'] })).toBe('token-value');
  });

  test('returns undefined when there is no command, it fails, or it prints nothing', async () => {
    expect(await readAgentKey({})).toBeUndefined();
    expect(await readAgentKey({ keyCommand: [] })).toBeUndefined();
    expect(await readAgentKey({ keyCommand: ['sh', '-c', 'echo partial; exit 3'] })).toBeUndefined();
    expect(await readAgentKey({ keyCommand: ['printf', ''] })).toBeUndefined();
    expect(await readAgentKey({ keyCommand: ['definitely-not-a-command-release-check'] })).toBeUndefined();
  });
});
