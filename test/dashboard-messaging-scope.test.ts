import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessagingCaptureSupervisor } from '../src/core/messaging-capture.ts';
import { createWorkerMessagingCaptureOwnership } from '../src/workers/email-source/server.ts';
import { createDashboardMessagingService, retainApprovedCaptureScope } from '../src/workers/email-source/dashboard-messaging-service.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('re-pair retains an existing narrow scope and refuses malformed old grants', () => {
  expect(retainApprovedCaptureScope('telegram', {
    OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: 'telegram.personal:chat:101',
    OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES: 'telegram.personal:chat:101',
  })).toEqual({ OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: 'telegram.personal:chat:101', OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES: 'telegram.personal:chat:101' });
  expect(retainApprovedCaptureScope('whatsapp', { OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: '123@s.whatsapp.net' })).toEqual({ OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: '123@s.whatsapp.net' });
  expect(() => retainApprovedCaptureScope('telegram', { OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: '*,telegram.personal:chat:101' })).toThrow();
});

const accountA = 'telegram:0123456789abcdef';
const accountB = 'telegram:fedcba9876543210';
const memorySecrets = { label: 'memory', get: async () => undefined, getSync: () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] };

async function waitFor(service: ReturnType<typeof createDashboardMessagingService>, source: 'telegram' | 'whatsapp', states: string[]) {
  for (let i = 0; i < 100; i++) {
    const status = await service.handle('status', { source });
    if (states.includes(status.state)) return status;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Pairing did not reach ' + states.join('/'));
}

for (const scenario of [
  { source: 'whatsapp', priorProof: 'whatsapp:authenticated-linked-device', proof: 'whatsapp:authenticated-linked-device', reuse: false },
  { source: 'telegram', priorProof: accountA, proof: accountA, reuse: true },
  { source: 'telegram', priorProof: accountA, proof: accountA, reuse: true, narrow: true },
  { source: 'telegram', priorProof: accountA, proof: accountB, reuse: false },
  { source: 'telegram', priorProof: accountA, proof: 'telegram:', reuse: false },
  { source: 'telegram', priorProof: undefined, proof: accountA, reuse: false },
] as const) {
  for (const ending of ['save', 'cancel', 'failure', 'early-failure'] as const) {
    if (scenario.reuse && ending === 'cancel') continue;
    test(`${scenario.source} re-pair ${scenario.priorProof ?? 'legacy'} -> ${scenario.proof}${'narrow' in scenario ? ' narrow' : ''}: ${ending}`, async () => {
      const { source, proof, priorProof, reuse } = scenario;
      const narrow = 'narrow' in scenario;
      const dir = mkdtempSync(join(tmpdir(), 'messaging-repair-')); dirs.push(dir);
      const registryPath = join(dir, 'handles.json');
      const grantPath = join(dir, `messaging-capture.${source}.json`);
      const key = source === 'telegram' ? 'OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES' : 'OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS';
      const chatScope = source === 'telegram' ? 'telegram.personal:chat:101' : 'whatsapp.personal:chat:123@s.whatsapp.net';
      writeFileSync(grantPath, JSON.stringify({ version: 1, source, handle: `${source}.personal`, sessionPath: dir, accountProof: priorProof, grantedAt: '2026-01-01', producer: { source, env: { [key]: narrow ? chatScope : '*' }, secretEnvironment: [] } }), { mode: 0o600 });
      const resumeStates: string[] = [];
      const makeSupervisor = () => new MessagingCaptureSupervisor({ source, registryPath, secretStore: memorySecrets, spawn: () => { throw new Error('Capture must not start'); } });
      const supervisor = makeSupervisor();
      const ownership = createWorkerMessagingCaptureOwnership({ env: {}, registryPath, packageRoot: dir,
        createSupervisor: () => ({ stop: () => supervisor.stop(), reconcile: async () => {
          const result = await supervisor.reconcile();
          resumeStates.push(result.reason ?? result.state);
          return result;
        } }),
      });
      const service = createDashboardMessagingService({ registryPath, secretStore: memorySecrets,
        withMessagingCapturePaused: ownership.withMessagingCapturePaused,
        withGrantMutation: async operation => operation(),
        listCommand: async () => ({ dialogs: [{ chat_scope: chatScope, title: 'One', kind: 'dm' }] }),
        pairSource: async options => {
          if (ending === 'early-failure') throw new Error('Helper failed after changing session');
          const approval = await options.requestCaptureScope!({ source, accountProof: proof, sessionPath: dir, chats: [{ chatScope, title: 'One', kind: 'dm' }] });
          if (!approval) throw new Error('Consent missing');
          if (ending === 'failure') throw new Error('Registration failed');
          options.onCommitStart?.();
          const selected = approval.source === 'telegram' ? approval.chatScopes?.join(',') : approval.chatJids?.join(',');
          const value = approval.wholeAccount ? '*' : selected!;
          return { ok: true, source, status: 'connected', registered: true, captureStarted: false, sessionPath: dir, accountProof: proof, chats: [], handles: [`${source}.personal`], secretRefs: [], producer: { source, executable: 'fixture', args: [], env: { [key]: value }, secretEnvironment: [], captureStarted: false } };
        },
      });
      try {
        await service.handle('start', { source });
        if (!reuse && ending !== 'early-failure') {
          expect((await waitFor(service, source, ['scope_selection_required', 'paired', 'failed'])).state).toBe('scope_selection_required');
          // A fresh supervisor models a worker restart while the user chooses.
          expect(await makeSupervisor().reconcile()).toMatchObject({ state: 'stopped', reason: 'grant_missing' });
          if (ending === 'cancel') await service.cancelAndWait(source);
          else await service.handle('scope', { source, wholeAccount: false, chatScopes: [chatScope] });
        }
        const state = ending === 'save' ? 'paired' : ending === 'cancel' ? 'cancelled' : 'failed';
        expect((await waitFor(service, source, [state])).state).toBe(state);
        // Even on success the pause wrapper runs before grant publication.
        expect(resumeStates).toEqual(['grant_missing']);
        if (ending === 'save') {
          const grant = JSON.parse(readFileSync(grantPath, 'utf8'));
          expect(grant.producer.env[key]).toBe(reuse && !narrow ? '*' : source === 'telegram' ? chatScope : '123@s.whatsapp.net');
          expect(grant.accountProof).toBe(source === 'telegram' && proof === accountB ? accountB : source === 'telegram' && proof === accountA ? accountA : undefined);
          expect(grant.pairingPending).toBeUndefined();
          expect(grant).not.toHaveProperty('tier');
        } else {
          expect(await makeSupervisor().reconcile()).toMatchObject({ state: 'stopped', reason: 'grant_missing' });
          await expect(service.handle('chats', { source })).rejects.toThrow();
        }
      } finally { await service.cancelAndWait(source); service.close(); await supervisor.stop(); }
    });
  }
}

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

test('re-pair never widens a grant removed during pairing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'messaging-race-')); dirs.push(dir);
  const grantPath = join(dir, 'messaging-capture.whatsapp.json');
  writeFileSync(grantPath, JSON.stringify({ version: 1, source: 'whatsapp', handle: 'whatsapp.personal', sessionPath: dir, grantedAt: '2026-01-01', producer: { source: 'whatsapp', env: { OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: '123@s.whatsapp.net' }, secretEnvironment: [] } }), { mode: 0o600 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const service = createDashboardMessagingService({ registryPath: join(dir, 'handles.json'),
    secretStore: { label: 'memory', get: async () => undefined, getSync: () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
    withMessagingCapturePaused: async (_source, operation) => operation(), withGrantMutation: async (operation) => operation(),
    pairSource: async () => { await held; return { ok: true, source: 'whatsapp', status: 'connected', registered: true, captureStarted: false, sessionPath: dir, accountProof: 'account', chats: [], handles: ['whatsapp.personal'], secretRefs: [], producer: { source: 'whatsapp', executable: 'fixture', args: [], env: { OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: '*' }, secretEnvironment: [], captureStarted: false } }; },
  });
  await service.handle('start', { source: 'whatsapp' });
  rmSync(grantPath);
  release();
  for (let i = 0; i < 30 && !['paired', 'failed'].includes((await service.handle('status', { source: 'whatsapp' })).state); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await service.handle('status', { source: 'whatsapp' })).state).toBe('failed');
  expect(() => readFileSync(grantPath)).toThrow();
  service.close();
});

for (const source of ['telegram', 'whatsapp'] as const) {
  for (const wholeAccount of [false, true]) test(`${source}: pairing waits for explicit ${wholeAccount ? 'account' : 'chat'} consent before registration and publication`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'messaging-consent-')); dirs.push(dir);
    const chatScope = source === 'telegram' ? 'telegram.personal:chat:101' : 'whatsapp.personal:chat:123@s.whatsapp.net';
    const grantPath = join(dir, `messaging-capture.${source}.json`);
    let registered = false;
    const service = createDashboardMessagingService({ registryPath: join(dir, 'handles.json'),
      secretStore: { label: 'memory', get: async () => undefined, getSync: () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
      withMessagingCapturePaused: async (_source, operation) => operation(), withGrantMutation: async operation => operation(),
      listCommand: async () => ({ dialogs: [{ chat_scope: chatScope, title: 'One', kind: 'dm' }] }),
      pairSource: async options => {
        const approval = options.captureScopeApproval ?? await options.requestCaptureScope?.({ source, accountProof: 'account', sessionPath: dir, chats: [{ chatScope, title: 'One', kind: 'dm' }] });
        if (!approval) throw new Error('Consent missing');
        options.onCommitStart?.();
        registered = true;
        const selected = approval.source === 'telegram' ? approval.chatScopes?.join(',') : approval.chatJids?.join(',');
        const value = approval.wholeAccount ? '*' : selected!;
        const env = source === 'telegram' ? { OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: value, OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES: value } : { OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: value };
        return { ok: true, source, status: 'connected', registered: true, captureStarted: false, sessionPath: dir, accountProof: 'account', chats: [], handles: [`${source}.personal`], secretRefs: [], producer: { source, executable: 'fixture', args: [], env, secretEnvironment: [], captureStarted: false } };
      },
    });
    try {
      await service.handle('start', { source });
      for (let i = 0; i < 30 && !['scope_selection_required', 'paired'].includes((await service.handle('status', { source })).state); i++) await new Promise(resolve => setTimeout(resolve, 0));
      expect(registered).toBe(false);
      expect(existsSync(grantPath)).toBe(false);
      expect(await service.handle('status', { source })).toMatchObject({ state: 'scope_selection_required', wholeAccount: false, chatScopes: [] });
      await expect(service.handle('scope', { source, wholeAccount: false, chatScopes: ['unknown'] })).rejects.toThrow();
      expect(registered).toBe(false);
      await service.handle('scope', { source, wholeAccount, chatScopes: wholeAccount ? [] : [chatScope] });
      for (let i = 0; i < 30 && (await service.handle('status', { source })).state !== 'paired'; i++) await new Promise(resolve => setTimeout(resolve, 0));
      expect(registered).toBe(true);
      const env = JSON.parse(readFileSync(grantPath, 'utf8')).producer.env;
      expect(env[source === 'telegram' ? 'OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES' : 'OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS']).toBe(wholeAccount ? '*' : source === 'telegram' ? chatScope : '123@s.whatsapp.net');
    } finally { await service.cancelAndWait(source); service.close(); }
  });
}

test('Choose chats before pairing is an answer (not_paired), not a failed request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'messaging-unpaired-')); dirs.push(dir);
  const service = createDashboardMessagingService({ registryPath: join(dir, 'handles.json'), secretStore: memorySecrets, withMessagingCapturePaused: (_s, op) => op(), withGrantMutation: op => op() });
  for (const source of ['telegram', 'whatsapp'] as const) expect(await service.handle('chats', { source })).toEqual({ ok: true, state: 'not_paired' });
});
