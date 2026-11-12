// The engine split runs one built-in model server per computer, in the
// background. The front's completions travel over the background's command
// socket (switch-on Mac check, 2026-11-12: a second server in the front made
// a private answer miss its deadline). This test runs both ends in-process.
import { expect, test } from 'bun:test';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { createEngineCommandHandler, EngineCommandLedger, parseEngineCommandEnvelope } from '../src/workers/engine-split/commands.ts';
import { completeModelInBackground } from '../src/workers/engine-split/runtime.ts';

const TOKEN = 'engine-split-model-token';

function background(modelComplete?: (request: AnalystModelRequest) => Promise<{ text: string; modelId: string }>) {
  const ledger = new EngineCommandLedger({ instanceId: 'background-1', handlers: {} });
  const handler = createEngineCommandHandler({ authToken: TOKEN, ledger, ready: () => true, ...(modelComplete ? { modelComplete } : {}) });
  return ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
}

test('a front completion runs on the background model with the same request and comes back whole', async () => {
  const seen: AnalystModelRequest[] = [];
  const fetchBackground = background(async (request) => {
    seen.push(request);
    return { text: 'answer', modelId: 'qwen', usage: { promptTokens: 3 } } as { text: string; modelId: string };
  });
  const completion = await completeModelInBackground(fetchBackground, TOKEN, {
    system: 'sys', prompt: 'evidence', localOnly: true, maxOutputChars: 900, responseSchema: { type: 'object' },
  });
  expect(completion).toEqual({ text: 'answer', modelId: 'qwen', usage: { promptTokens: 3 } } as typeof completion);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ system: 'sys', prompt: 'evidence', localOnly: true, maxOutputChars: 900, responseSchema: { type: 'object' } });
  expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
});

test('the model\'s typed refusal reaches the front as the same error it raises in one process', async () => {
  const fetchBackground = background(async () => {
    throw new OperationError('argus_unreachable', 'The built-in private model is still downloading (40%).', 'nothing needs to be done');
  });
  const failure = await completeModelInBackground(fetchBackground, TOKEN, { system: 's', prompt: 'p', localOnly: true }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(OperationError);
  expect((failure as OperationError).code).toBe('argus_unreachable');
  expect((failure as OperationError).message).toContain('still downloading');
});

test('without a model, a wrong token or a malformed request the background runs nothing', async () => {
  const none = await completeModelInBackground(background(), TOKEN, { system: 's', prompt: 'p', localOnly: true }).catch((error: unknown) => error);
  expect(none).toBeInstanceOf(OperationError);
  let calls = 0;
  const fetchBackground = background(async () => { calls += 1; return { text: '', modelId: 'm' }; });
  const wrongToken = await completeModelInBackground(fetchBackground, 'not-the-token', { system: 's', prompt: 'p', localOnly: true }).catch((error: unknown) => error);
  expect(wrongToken).toBeInstanceOf(OperationError);
  const malformed = await fetchBackground('http://olympus-background/engine/model/complete', {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ system: 's', prompt: 1, localOnly: true }),
  });
  expect(malformed.status).toBe(400);
  expect(calls).toBe(0);
});

test('model_prepare is a command the background accepts', () => {
  expect(parseEngineCommandEnvelope({ id: 'a'.repeat(32), command: { kind: 'model_prepare' } }).command).toEqual({ kind: 'model_prepare' });
});
