import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { connectApiKeySource, connectGuidedSession } from '../src/core/connect.ts';
import { EncryptedFileSecretStore } from '../src/core/secret-store.ts';
import { createEnvCredentialBroker } from '../src/workers/credential-broker/index.ts';

describe('credential onboarding no-secret-material guard', () => {
  test('connect results, registries, statuses, and errors do not expose secret material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-no-secret-material-test-'));
    const registryPath = join(dir, 'handles.json');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const fixtures = [
      'readwise-token-fixture-secret',
      'notion-token-fixture-secret',
      'telegram-session-path-fixture-secret',
      'missing-refresh-token-fixture-secret',
    ];
    try {
      const readwise = await connectApiKeySource({
        source: 'readwise',
        apiKey: fixtures[0]!,
        registryPath,
        secretStore: store,
        fetch: async () => new Response('', { status: 204 }),
      });
      const notion = await connectApiKeySource({
        source: 'notion',
        apiKey: fixtures[1]!,
        registryPath,
        secretStore: store,
        fetch: async () => new Response(JSON.stringify({ object: 'user' }), { status: 200 }),
      });
      const telegram = await connectGuidedSession({
        source: 'telegram',
        sessionPath: fixtures[2]!,
        registryPath,
        secretStore: store,
      });
      const broker = createEnvCredentialBroker({
        env: {},
        handleRegistryPath: registryPath,
        secretStore: store,
      });
      const status = await broker.status?.('readwise.personal');
      const notionStatus = await broker.status?.('notion.personal');
      let errorText = '';
      try {
        await broker.issueSession({
          handle: 'dropbox.personal',
          provider: 'dropbox',
          capability: 'dropbox.files.sync',
          trustDomain: 'secure_local',
        });
      } catch (error) {
        errorText = String(error);
      }
      const inspected = [
        JSON.stringify(readwise),
        JSON.stringify(notion),
        JSON.stringify(telegram),
        readFileSync(registryPath, 'utf8'),
        JSON.stringify(status),
        JSON.stringify(notionStatus),
        errorText,
      ].join('\n');

      for (const fixture of fixtures) {
        expect(inspected).not.toContain(fixture);
      }
      expect(inspected).not.toContain('OLYMPUS_CREDENTIAL');
      expect(inspected).not.toContain('READWISE_TOKEN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
