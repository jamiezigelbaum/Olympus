// olympus connect gemini: the only supported way to put the Gemini API key
// where the supervised worker actually reads it (its own process environment,
// loaded from worker.env).
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { connectGeminiApiKey } from '../src/core/connect.ts';
import { writeManagedWorkerEnvSecret } from '../src/core/worker-service.ts';

describe('olympus connect gemini', () => {
  test('connect gemini stores the key where the supervised worker reads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-fresh-install-gemini-'));
    try {
      const envPath = join(dir, 'worker.env');

      // Before setup there is no worker environment to store it in, and the
      // refusal says which command creates one.
      await expect(connectGeminiApiKey({ apiKey: 'k', envPath, validate: false }))
        .rejects.toThrow('No Olympus worker environment exists');

      writeFileSync(envPath, '# Olympus source worker environment.\nPATH=/usr/bin\n', { mode: 0o600 });
      const requested: Array<{ url: string; apiKeyHeader: string | null }> = [];
      const result = await connectGeminiApiKey({
        apiKey: '  gemini-test-key  ',
        envPath,
        geminiModelsUrl: 'https://gemini.test/v1beta/models',
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requested.push({
            url: String(input),
            apiKeyHeader: new Headers(init?.headers).get('x-goog-api-key'),
          });
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
      });

      // The key travels in a header: a key in the query string lands in every
      // proxy and access log on the way.
      expect(requested).toEqual([{
        url: 'https://gemini.test/v1beta/models',
        apiKeyHeader: 'gemini-test-key',
      }]);
      expect(result).toMatchObject({
        ok: true,
        source: 'gemini',
        secretRefs: ['env:OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY'],
      });
      expect(result.next).toContain('olympus worker restart');
      expect(JSON.stringify(result)).not.toContain('gemini-test-key');

      const stored = parseEnvFile(readFileSync(envPath, 'utf8'));
      expect(stored.OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY).toBe('gemini-test-key');
      expect(stored.PATH).toBe('/usr/bin');
      expect(statSync(envPath).mode & 0o777).toBe(0o600);

      // Re-running replaces the value rather than appending a second one.
      await connectGeminiApiKey({ apiKey: 'gemini-rotated-key', envPath, validate: false });
      const text = readFileSync(envPath, 'utf8');
      expect(text.match(/^OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY=/gm)).toHaveLength(1);
      expect(parseEnvFile(text).OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY).toBe('gemini-rotated-key');

      // A rejected key is never stored.
      await expect(connectGeminiApiKey({
        apiKey: 'gemini-wrong-key',
        envPath,
        geminiModelsUrl: 'https://gemini.test/v1beta/models',
        fetch: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch,
      })).rejects.toThrow('Gemini rejected the API key');
      expect(parseEnvFile(readFileSync(envPath, 'utf8')).OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY)
        .toBe('gemini-rotated-key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test('a value that could forge a second worker.env assignment is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-fresh-install-env-injection-'));
    try {
      const envPath = join(dir, 'worker.env');
      writeFileSync(envPath, 'PATH=/usr/bin\n', { mode: 0o600 });
      expect(() => writeManagedWorkerEnvSecret({
        key: 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
        value: 'key\nOLYMPUS_WORKER_AUTH_TOKEN=stolen',
        envPath,
      })).toThrow('must not contain line breaks');
      expect(readFileSync(envPath, 'utf8')).toBe('PATH=/usr/bin\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2] ?? '';
  }
  return env;
}
