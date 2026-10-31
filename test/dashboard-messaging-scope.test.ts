import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardMessagingService } from '../src/workers/email-source/dashboard-messaging-service.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('chat selection writes the pairing grant, stops capture during the change, and refuses stale lists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'messaging-scope-')); dirs.push(dir);
  const registryPath = join(dir, 'handles.json');
  const grantPath = join(dir, 'messaging-capture.telegram.json');
  const grant = { version: 1, source: 'telegram', handle: 'telegram.personal', sessionPath: join(dir, 'telegram'), grantedAt: '2026-01-01T00:00:00Z', producer: { source: 'telegram', secretEnvironment: [], env: { OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: '*', OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES: '*' } } };
  writeFileSync(grantPath, JSON.stringify(grant), { mode: 0o600 });
  let paused = false;
  let writes = 0;
  let finishListing!: () => void;
  const listingHeld = new Promise<void>((resolve) => { finishListing = resolve; });
  const service = createDashboardMessagingService({ registryPath,
    secretStore: { label: 'memory', get: async (key) => key.endsWith('api_id') ? '123' : 'fixture-hash', getSync: () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
    withMessagingCapturePaused: async (_source, operation) => { paused = true; try { return await operation(); } finally { paused = false; } },
    withGrantMutation: async (operation) => { writes++; return operation(); },
    listCommand: async () => { expect(paused).toBe(true); await listingHeld; return { dialogs: [{ chat_scope: 'telegram.personal:chat:101', kind: 'dm', title: 'One' }] }; },
  });
  const pending = service.handle('chats', { source: 'telegram' });
  await expect(service.handle('start', { source: 'telegram' })).rejects.toThrow();
  finishListing();
  const listing = await pending;
  expect(listing).toMatchObject({ wholeAccount: true });
  await expect(service.handle('scope', { source: 'telegram', wholeAccount: false, chatScopes: ['telegram.personal:chat:999'] })).rejects.toThrow();
  await service.handle('scope', { source: 'telegram', wholeAccount: false, chatScopes: ['telegram.personal:chat:101'] });
  const saved = JSON.parse(readFileSync(grantPath, 'utf8'));
  expect(saved.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES).toBe('telegram.personal:chat:101');
  expect(saved.producer.env.OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES).toBe('telegram.personal:chat:101');
  expect(writes).toBe(2);
  await expect(service.handle('scope', { source: 'telegram', wholeAccount: true, chatScopes: [] })).rejects.toThrow();
  saved.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = 'telegram.personal:chat:101,*';
  writeFileSync(grantPath, JSON.stringify(saved), { mode: 0o600 });
  await expect(service.handle('chats', { source: 'telegram' })).rejects.toThrow();
  service.close();
});
