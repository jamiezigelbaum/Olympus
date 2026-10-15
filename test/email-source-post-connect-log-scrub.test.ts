// The post-connect first sync runs the instant a credential is accepted, so a
// failure there prints provider text at the one moment fresh credentials are in
// play. Every other log call in this worker goes through the scrubber; this one
// is on the same rail.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type { ReadwiseConnectorStoreSyncHandler } from '../src/workers/readwise/index.ts';

const PROVIDER_BODY_ECHO = 'Token abcdefghijklmnopqrstuvwxyz0123456789';

describe('post-connect first sync logging', () => {
  test('a failed first sync is reported through the worker scrubber', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-post-connect-log-'));
    const registryPath = join(dir, 'handles.json');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };
    try {
      const worker = createEmailSourceWorker({
        // The Readwise API error carries up to 240 characters of raw provider
        // response body, which is exactly what must not reach the journal.
        readwiseConnectorStoreSync: {
          async sync() {
            throw new Error(`Readwise sync failed: ${PROVIDER_BODY_ECHO} ${'x'.repeat(400)}`);
          },
        } as unknown as ReadwiseConnectorStoreSyncHandler,
        sourceDashboard: {
          // A logging fixture must not read another test's/default registry.
          registryPath,
          secretStore: { label: 'synthetic', get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
          sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
          async connectApiKey({ source }) {
            return {
              ok: true,
              source,
              handles: ['readwise.personal'],
              registryPath,
              secretRefs: [],
            };
          },
        },
      });

      const response = await worker.fetch(new Request('http://worker.test/dashboard/connect/api-key', {
        method: 'POST',
        body: JSON.stringify({ source: 'readwise', api_key: 'rw-test-key' }),
        headers: { 'Content-Type': 'application/json' },
      }));

      expect({ status: response.status, body: await response.clone().json() }).toMatchObject({ status: 200, body: { ok: true } });
      // The acknowledgment is returned before the background import finishes.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnings).toHaveLength(1);
      const warning = warnings[0]!;
      expect(warning).toContain('initial sync needs attention for readwise');
      expect(warning).toContain('<redacted>');
      expect(warning).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
      expect(warning.length).toBeLessThan(300);
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
