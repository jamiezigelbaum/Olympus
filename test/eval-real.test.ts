import { describe, expect, test } from 'bun:test';
import { DEFAULT_VENICE_ANALYST_MODEL } from '../src/core/analyst-venice.ts';
import { defaultConfig } from '../src/core/config.ts';
import {
  createEvalAnalystModel,
  effectiveIsolatedQuestionTimeoutMs,
  parseEvalRealArgs,
  releasedVisibleUnanswered,
  resolveEvalAnalystProvider,
  resolveEvalDropboxScope,
} from '../eval/run-real.ts';

describe('real eval runner options', () => {
  test('the parent process enforces the tighter question deadline', () => {
    expect(effectiveIsolatedQuestionTimeoutMs(240_000, {})).toBe(240_000);
    expect(effectiveIsolatedQuestionTimeoutMs(240_000, { maxDurationMs: 60_000 })).toBe(60_000);
    expect(effectiveIsolatedQuestionTimeoutMs(60_000, { maxDurationMs: 240_000 })).toBe(60_000);
  });

  test('parses analyst-provider from cli or env', () => {
    expect(parseEvalRealArgs([], {}).analystProvider).toBe('local');
    expect(parseEvalRealArgs(['--analyst-provider', 'venice', 'eval/private/custom.json'], {}).analystProvider)
      .toBe('venice');
    expect(parseEvalRealArgs(['--analyst-provider=venice'], {}).datasetPath)
      .toBe('eval/private/held-out.real.json');
    expect(parseEvalRealArgs(['eval/private/custom.json'], { OLYMPUS_EVAL_ANALYST_PROVIDER: 'venice' }))
      .toEqual({ datasetPath: 'eval/private/custom.json', analystProvider: 'venice' });
    expect(() => resolveEvalAnalystProvider('cloud')).toThrow('local or venice');
  });

  test('released visible unanswered only counts gaps present in the released answer', () => {
    expect(releasedVisibleUnanswered('I could not extract a cited bounded answer.', true)).toEqual([]);
    expect(releasedVisibleUnanswered('Answer.\n\nCoverage notes:\n- 1 source item could not be read.', true))
      .toEqual(['- 1 source item could not be read.']);
    expect(releasedVisibleUnanswered('I found matching source material, but this needs review.', true)).toEqual([]);
    expect(releasedVisibleUnanswered('Coverage notes:\n- hidden', false)).toEqual([]);
  });

  test('resolves an optional Dropbox path scope through the canonical codec', () => {
    expect(resolveEvalDropboxScope('personal', undefined)).toEqual({ accountScope: 'personal' });
    expect(resolveEvalDropboxScope('personal', 'dropbox.personal:/1 Projects')).toEqual({
      accountScope: 'personal',
      locatorPathScope: '/1 Projects',
    });
    expect(() => resolveEvalDropboxScope(undefined, 'dropbox.personal:/1 Projects'))
      .toThrow('OLYMPUS_SOURCE_INDEX_ACCOUNT is required');
    expect(() => resolveEvalDropboxScope('business', 'dropbox.personal:/1 Projects'))
      .toThrow('must be a Dropbox path scope');
    expect(() => resolveEvalDropboxScope('personal', 'dropbox.personal:folder:123'))
      .toThrow('must be a Dropbox path scope');
  });

  test('the local eval follows the production source_answer profile unless a lane override is explicit', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; model?: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as { model?: string } : undefined;
      requests.push({ url, ...(body?.model ? { model: body.model } : {}) });
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'available' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        model: body?.model,
        choices: [{ message: { content: '{"answer":"fixture","citations":[],"unanswered":[],"sufficient":true}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const config = defaultConfig();
      config.argus.modelProfiles.source_answer = {
        ...config.argus.modelProfiles.source_answer,
        baseUrl: 'http://source-answer.test/v1',
        model: 'delphi/source-answer-test',
      };
      config.argus.lanes.deep = {
        ...config.argus.lanes.deep,
        baseUrl: 'http://deep-lane.test/v1',
        model: 'delphi/deep-lane-test',
      };

      await createEvalAnalystModel({ provider: 'local', config, env: {} }).complete({
        system: 'sys',
        prompt: 'Question: fixture',
        localOnly: true,
      });
      expect(requests.map((request) => request.url)).toEqual([
        'http://source-answer.test/v1/models',
        'http://source-answer.test/v1/chat/completions',
      ]);
      expect(requests[1]?.model).toBe('delphi/source-answer-test');

      requests.length = 0;
      await createEvalAnalystModel({
        provider: 'local',
        config,
        env: { OLYMPUS_SOURCE_INDEX_ANALYST_LANE: 'deep' },
      }).complete({
        system: 'sys',
        prompt: 'Question: fixture',
        localOnly: true,
      });
      expect(requests.map((request) => request.url)).toEqual([
        'http://deep-lane.test/v1/models',
        'http://deep-lane.test/v1/chat/completions',
      ]);
      expect(requests[1]?.model).toBe('delphi/deep-lane-test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('the Venice eval lane defaults to the sanctioned Private model, never a gated e2ee id', async () => {
    const originalFetch = globalThis.fetch;
    const dispatched: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      dispatched.push(String((JSON.parse(String(init?.body)) as { model?: unknown }).model));
      return new Response(JSON.stringify({
        model: 'kimi-k3',
        choices: [{
          message: {
            content: JSON.stringify({ answer: 'a', citations: [], unanswered: [], sufficient: true }),
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const model = createEvalAnalystModel({
        provider: 'venice',
        config: defaultConfig(),
        env: { OLYMPUS_EVAL_VENICE_API_KEY: 'venice-secret' },
      });

      await model.complete({ system: 'sys', prompt: 'Question: fixture', localOnly: true });

      expect(dispatched).toEqual([DEFAULT_VENICE_ANALYST_MODEL]);
      expect(dispatched[0]!.startsWith('e2ee-')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('constructs the Venice eval analyst lane against a fixture', async () => {
    const originalFetch = globalThis.fetch;
    const captured: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({
        model: 'e2ee-glm-5-2-p',
        choices: [{
          message: {
            content: JSON.stringify({
              answer: 'Venice eval answer.',
              citations: [{ evidence: 1, claim: 'Venice eval claim' }],
              unanswered: [],
              sufficient: true,
            }),
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const model = createEvalAnalystModel({
        provider: 'venice',
        config: defaultConfig(),
        env: {
          OLYMPUS_EVAL_VENICE_API_KEY: 'venice-secret',
          OLYMPUS_EVAL_VENICE_ANALYST_BASE_URL: 'https://api.venice.ai/api/v1',
          OLYMPUS_EVAL_VENICE_ANALYST_MODEL: 'e2ee-glm-5-2-p',
          OLYMPUS_EVAL_VENICE_ANALYST_THINKING: 'disabled',
        },
      });

      const completion = await model.complete({
        system: 'You are an evidence analyst.',
        prompt: 'Question: fixture\n\nEvidence:\n[1] fixture',
        localOnly: true,
      });

      expect(completion.text).toContain('Venice eval answer');
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        url: 'https://api.venice.ai/api/v1/chat/completions',
        headers: { Authorization: 'Bearer venice-secret' },
      });
      expect(captured[0]!.body).toMatchObject({
        model: 'e2ee-glm-5-2-p',
        venice_parameters: {
          enable_web_search: 'off',
          include_venice_system_prompt: false,
          disable_thinking: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
