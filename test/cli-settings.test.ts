// `olympus settings show` (#1050): an agent helping the owner reads every
// dashboard setting as JSON instead of asking the owner to read the screen.
// Read-only: it never writes, and changing a setting stays a click in the
// local dashboard.

import { describe, expect, test } from 'bun:test';
import { runSettingsCommand } from '../src/cli.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { settingsForCli } from '../src/workers/cli-operations.ts';

describe('settingsForCli', () => {
  test('reports each setting from the dashboard status sources, without spend history or secrets', async () => {
    const snapshot = await settingsForCli({
      answerMode: () => ({ id: 'local-first', label: 'Local models with Venice fallback' }),
      computerSetup: () => ({ computer_use_pending: false, engine_server_mode: { enabled: true, pending: false } }),
      judge: () => ({ choice: 'venice', capDollars: 5, spentDollars: 1.25, remainingDollars: 3.75, stop: null, cloudModel: 'qwen3-235b', cloudAvailable: true }),
      modelChoices: async () => ({
        venice: { provider: 'venice', current: 'strongest', strongestNow: 'qwen3-235b', options: [{ value: 'strongest', label: 'Always the strongest' }, { value: 'qwen3-235b', label: 'Qwen 3' }] },
      }),
    });
    expect(snapshot).toEqual({
      kind: 'olympus_settings',
      private_answer_mode: { id: 'local-first', label: 'Local models with Venice fallback' },
      computer_use: { choice: 'server', change_pending: false },
      privacy_judge: { choice: 'venice', spending_limit_dollars: 5, spent_dollars: 1.25, stopped: null, cloud_model: 'qwen3-235b' },
      models: { venice: { current: 'strongest', strongest_now: 'qwen3-235b', options: ['strongest', 'qwen3-235b'] } },
      outside_help: null,
    });
  });

  test('a pending computer choice reads as not chosen, and an unavailable source as null', async () => {
    const snapshot = await settingsForCli({
      answerMode: () => ({ id: 'custom', label: 'Custom Private-answer mode' }),
      computerSetup: () => ({ computer_use_pending: true, engine_server_mode: { enabled: false, pending: false } }),
      modelChoices: async () => { throw new Error('catalog down'); },
    });
    expect(snapshot.computer_use).toEqual({ choice: null, change_pending: false });
    expect(snapshot.models).toBeNull();
    expect(snapshot.privacy_judge).toBeNull();
  });
});

describe('runSettingsCommand', () => {
  test('there is no direct apply: only show, schema and propose', async () => {
    await expect(runSettingsCommand(['apply', 'x.json'])).rejects.toBeInstanceOf(OperationError);
    await expect(runSettingsCommand([])).rejects.toThrow('Usage: olympus settings show | schema | propose');
  });

  test('schema names every settable key', async () => {
    const schema = await runSettingsCommand(['schema']);
    expect(Object.keys(schema.keys as object).sort()).toEqual(['computer_use', 'models', 'privacy_judge', 'private_answer_mode']);
  });

  test('propose checks the file before reaching Olympus', async () => {
    const env = { HOME: '/nonexistent-olympus-home', OLYMPUS_WORKER_AUTH_TOKEN: 'token' };
    const never: typeof fetch = Object.assign(async () => { throw new Error('must not be called'); }, { preconnect: () => {} });
    await expect(runSettingsCommand(['propose', '-'], env, { fetchImpl: never, readStdin: () => '{"remote_access": true}' })).rejects.toThrow('cannot set remote_access');
    await expect(runSettingsCommand(['propose', '-'], env, { fetchImpl: never, readStdin: () => 'not json' })).rejects.toThrow('not valid JSON');
    await expect(runSettingsCommand(['propose'], env, { fetchImpl: never })).rejects.toThrow('Usage');
  });

  test('propose sends the proposal and the agent name to the running Olympus', async () => {
    const env = { HOME: '/nonexistent-olympus-home', OLYMPUS_WORKER_AUTH_TOKEN: 'token' };
    const sent: unknown[] = [];
    const worker: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response('ok');
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ kind: 'olympus_settings_proposal', id: 'p1', changes: [] });
    }, { preconnect: () => {} });
    const result = await runSettingsCommand(['propose', '-', '--from', 'Claude Code'], env, { fetchImpl: worker, readStdin: () => '{"models":{"venice":"strongest"}}' });
    expect(result).toMatchObject({ kind: 'olympus_settings_proposal', id: 'p1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ body: { proposal: { models: { venice: 'strongest' } }, from: 'Claude Code' } });
    expect((sent[0] as { url: string }).url).toEndWith('/cli/settings-propose');
  });

  test('says to start Olympus when no worker answers', async () => {
    const env = { HOME: '/nonexistent-olympus-home', OLYMPUS_WORKER_AUTH_TOKEN: 'token' };
    const refused: typeof fetch = Object.assign(async () => { throw new Error('connect ECONNREFUSED'); }, { preconnect: () => {} });
    await expect(runSettingsCommand(['show'], env, { fetchImpl: refused })).rejects.toThrow('Olympus is not running');
  });
});
