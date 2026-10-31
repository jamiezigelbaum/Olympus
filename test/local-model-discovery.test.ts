import { describe, expect, test } from 'bun:test';
import { LocalModelDiscovery } from '../src/core/local-model-discovery.ts';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function service(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return new LocalModelDiscovery({ fetch: async (url, init) => handler(url, init), timeoutMs: 50 });
}

describe('local model discovery', () => {
  test('detects only the standard loopback Ollama and LM Studio endpoints', async () => {
    const requests: string[] = [];
    const results = await service((url, init) => {
      requests.push(url);
      expect(init.redirect).toBe('error');
      return response({ data: [{ id: 'local-chat' }, { id: 'gpt-oss:120b-cloud' }] });
    }).discover();
    expect(requests.sort()).toEqual(['http://127.0.0.1:11434/v1/models', 'http://127.0.0.1:1234/v1/models']);
    expect(results.map(item => item.provider)).toEqual(['ollama', 'lm-studio']);
    expect(results.every(item => item.models.find(model => model.id === 'gpt-oss:120b-cloud')?.allowed === false)).toBe(true);
  });

  test('rejects non-loopback, credentials, query and fragment before any network request', async () => {
    let calls = 0;
    const discovery = service(() => { calls++; return response({}); });
    for (const url of ['http://192.168.1.10:1234', 'https://example.com/v1', 'http://localhost.evil/v1', 'http://user@localhost/v1', 'http://localhost/v1?key=x', 'http://localhost/v1#x', 'file:///etc/passwd']) {
      const result = await discovery.discover(url);
      expect(result[0]?.step).toBe('endpoint');
      expect(result[0]?.working).toBe(false);
    }
    expect(calls).toBe(0);
  });

  test('normalizes typed loopback endpoints and lists unique model IDs', async () => {
    const requests: string[] = [];
    const results = await service(url => { requests.push(url); return response({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }); }).discover('http://[::1]:9000');
    expect(requests).toEqual(['http://[::1]:9000/v1/models']);
    expect(results[0]?.models.map(item => item.id)).toEqual(['a', 'b']);
  });

  test('checks the answer model without requesting embeddings', async () => {
    const bodies: unknown[] = [];
    const discovery = service((url, init) => {
      if (url.endsWith('/models')) return response({ data: [{ id: 'answer' }, { id: 'embed' }] });
      bodies.push(JSON.parse(String(init.body)));
      return url.endsWith('/embeddings') ? response({ data: [{ embedding: [0.1, 0.2] }] }) : response({ choices: [{ message: { content: 'ready' } }] });
    });
    expect(await discovery.test({ baseUrl: 'http://localhost:1234', answerModel: 'answer' })).toEqual({ working: true, step: 'complete', detail: 'Working' });
    expect(bodies).toEqual([
      { model: 'answer', messages: [{ role: 'user', content: 'Reply with one word: ready.' }], temperature: 0, max_tokens: 8 },
    ]);
  });

  test('refuses cloud models before making any request', async () => {
    let calls = 0;
    const discovery = service(() => { calls++; return response({}); });
    const result = await discovery.test({ baseUrl: 'http://localhost:11434/v1', answerModel: 'gpt-oss:120b-cloud' });
    expect(result.working).toBe(false);
    expect(result.step).toBe('answer');
    expect(result.detail).toContain('cloud');
    expect(calls).toBe(0);
  });

  test('maps answer HTTP failure without reflecting response bodies', async () => {
    const failure = 'answer';
    const discovery = service(url => {
      if (url.endsWith('/models')) return response({ data: [{ id: 'answer' }, { id: 'embed' }] });
      if (url.endsWith(failure === 'answer' ? '/chat/completions' : '/embeddings')) return response({ error: 'private server detail' }, 503);
      return response({ choices: [{ message: { content: 'ready' } }] });
    });
    const result = await discovery.test({ baseUrl: 'http://localhost:1234/v1', answerModel: 'answer' });
    expect(result.working).toBe(false);
    expect(result.step).toBe(failure);
    expect(result.detail).toContain('503');
    expect(result.detail).not.toContain('private server detail');
  });

  test('refuses redirects and reports missing selected models without inference', async () => {
    let calls = 0;
    const missing = await service(() => { calls++; return response({ data: [{ id: 'other' }] }); }).test({ baseUrl: 'http://127.0.0.1:1234/v1', answerModel: 'answer' });
    expect(missing.step).toBe('answer');
    expect(calls).toBe(1);
    const redirected = await service(() => new Response(null, { status: 302, headers: { Location: 'https://example.com' } })).discover('http://localhost:1234/v1');
    expect(redirected[0]?.working).toBe(false);
    expect(redirected[0]?.detail).toContain('redirect');
  });
  test('maps a stalled model list to a bounded timeout error', async () => {
    const result = await service(() => new Promise<Response>(() => {})).discover('http://127.0.0.1:1234');
    expect(result[0]?.working).toBe(false);
    expect(result[0]?.step).toBe('models');
    expect(result[0]?.detail).toContain('timed out');
  });

});

test('saving a verified answer model preserves the rest of the policy and rejects stale policy', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadSovereigntyPreset } = await import('../src/core/sovereignty.ts');
  const { saveLocalAnswerModel } = await import('../src/core/local-model-discovery.ts');
  const dir = mkdtempSync(join(tmpdir(), 'local-answer-save-'));
  try {
    const path = join(dir, 'policy.json');
    const original = loadSovereigntyPreset('local-only');
    writeFileSync(path, JSON.stringify(original));
    const discovery = service(url => url.endsWith('/models') ? response({ data: [{ id: 'answer' }] }) : response({ choices: [{ message: { content: 'ready' } }] }));
    const saved = await saveLocalAnswerModel({ path, expected: original, selection: { baseUrl: 'http://localhost:1234', answerModel: 'answer' }, discovery });
    expect(saved.ok).toBe(true);
    const current = JSON.parse(readFileSync(path, 'utf8'));
    expect(current.modelProfiles['local-source-answer']).toMatchObject({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'answer' });
    expect(current.modelProfiles['built-in-embedding']).toEqual(original.modelProfiles['built-in-embedding']);
    expect(current.routes).toEqual(original.routes);
    expect(current.retrieval).toEqual(original.retrieval);
    const stale = await saveLocalAnswerModel({ path, expected: original, selection: { baseUrl: 'http://localhost:1234', answerModel: 'answer' }, discovery });
    expect(stale.ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
