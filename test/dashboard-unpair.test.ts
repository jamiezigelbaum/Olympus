// Unpair is Disconnect's twin for the two paired-session sources. Telegram and
// WhatsApp live outside the credential broker, so the broker-shaped Disconnect
// row never appeared for them and a reader who wanted to end the pairing had no
// control at all (owner decision, 2026-09-02).
//
// What these tests pin is the part that is easy to get wrong destructively:
// Unpair removes the pairing session artifacts ONLY. The WhatsApp spool and
// media directories hold the raw message text and captured audio — the corpus
// itself — and an Unpair that touched them would be a silent data deletion
// behind a button labelled as a disconnect.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  readConnectedHandleRegistry,
  writeConnectedHandleRegistry,
  type ConnectedCredentialHandle,
  type ConnectedHandleRegistry,
} from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import {
  readUnpairedSources,
  reconcileUnpairedSource,
  unpairedLaneProviders,
  unpairedSourcesPath,
  writeUnpairedSources,
} from '../src/workers/credential-broker/unpaired-sources.ts';
import { connectGuidedSession } from '../src/core/connect.ts';
import { clearUnpairedSource } from '../src/workers/credential-broker/unpaired-sources.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { isV04PublicDashboardRoute } from '../src/core/public-surface.ts';
import {
  PairingSessionPathError,
  planPairingSessionRemoval,
  removePlannedPairingSessionFile,
  telegramPairingSessionPaths,
  whatsappPairingSessionPaths,
} from '../src/core/pairing-session-paths.ts';

const dirs: string[] = [];
const workers: Array<{ close(): void }> = [];

afterEach(() => {
  // Closed before the directories go: a worker left ticking would keep
  // re-reading a registry inside a temporary directory this test no longer
  // owns, and the noise lands in whichever test is running next.
  for (const worker of workers.splice(0)) worker.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Every worker this suite creates, remembered so afterEach can close it.
 *
 * The worker owns a background adoption tick. One created without a disposer is
 * a leak by construction, so nothing here is allowed to create one untracked.
 */
function trackWorker<T extends { close(): void }>(worker: T): T {
  workers.push(worker);
  return worker;
}

/** Fail loudly instead of hanging: a read that never returns is the bug. */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('bounded dashboard Unpair', () => {
  test('removes the local Telegram pairing session, parks the lane, and leaves the capture spool and indexed data alone', async () => {
    const home = fixtureHome();
    const sessionPath = touch(join(home, '.local/share/olympus/telegram/telegram.personal.session'));
    const journalPath = touch(join(home, '.local/share/olympus/telegram/telegram.personal.session-journal'));
    const spoolItem = touch(join(home, '.local/share/olympus/telegram-capture/spool/0001.jsonl'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionPath });
    const schedulerUpdates: unknown[][] = [];
    const refreshedWith: ConnectedCredentialHandle[][] = [];
    const worker = trackWorker(createEmailSourceWorker({
      sourceScheduler: {
        status: () => ({ enabled: true, running: false, sources: [] }),
        updateSources: (sources: unknown[]) => schedulerUpdates.push(sources),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
        refreshSchedulerSources: (handles) => {
          refreshedWith.push([...(handles ?? [])]);
          return [];
        },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      source_id: 'telegram.messages',
      removed_handles: ['telegram.personal'],
      removed_session_paths: [journalPath, sessionPath].sort(),
      scheduling_refreshed: true,
      policy: {
        scheduled_reads_stopped: true,
        manual_reads_stopped: true,
        local_pairing_session_removed: true,
        indexed_data_deleted: false,
        captured_messages_deleted: false,
        provider_device_still_linked: true,
        restart_required: false,
        raw_runtime_secrets_exposed: false,
      },
    });
    expect(existsSync(sessionPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    // The capture spool is the raw corpus, never pairing state.
    expect(existsSync(spoolItem)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
    expect(await secrets.get('telegram.personal.session_path')).toBeUndefined();
    expect(refreshedWith).toEqual([[]]);
    expect(schedulerUpdates).toEqual([[]]);
  });

  test('removes only the WhatsApp session artifacts, never the spool or media that hold message text', async () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const sessionWal = touch(join(stateDir, 'session.db-wal'));
    const sessionShm = touch(join(stateDir, 'session.db-shm'));
    const qr = touch(join(stateDir, 'qr.txt'));
    const spoolItem = touch(join(stateDir, 'spool/0001.jsonl'));
    const mediaItem = touch(join(stateDir, 'media/voice-note.ogg'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const secrets = memorySecretStore({ 'whatsapp.personal_local.session_path': sessionDb });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      source_id: 'whatsapp.personal.messages',
      removed_handles: ['whatsapp.personal_local'],
      removed_session_paths: [qr, sessionDb, sessionShm, sessionWal].sort(),
      policy: {
        indexed_data_deleted: false,
        captured_messages_deleted: false,
        provider_device_still_linked: true,
      },
    });
    for (const path of [sessionDb, sessionWal, sessionShm, qr]) expect(existsSync(path)).toBe(false);
    expect(existsSync(spoolItem)).toBe(true);
    expect(existsSync(mediaItem)).toBe(true);
    expect(await secrets.get('whatsapp.personal_local.session_path')).toBeUndefined();
  });

  test('requires the same explicit acknowledgement Disconnect requires', async () => {
    const home = fixtureHome();
    const sessionPath = touch(join(home, '.local/share/olympus/telegram/telegram.personal.session'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', { source_id: 'telegram.messages' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unpair_confirmation_required' },
    });
    expect(existsSync(sessionPath)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
  });

  test('refuses while that source is finishing a read, before anything is removed', async () => {
    const home = fixtureHome();
    const sessionPath = touch(join(home, '.local/share/olympus/telegram/telegram.personal.session'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const schedulerUpdates: unknown[][] = [];
    const worker = trackWorker(createEmailSourceWorker({
      sourceScheduler: {
        status: () => ({
          enabled: true,
          running: true,
          sources: [{
            source_id: 'telegram.messages',
            corpus_id: 'internal.telegram.messages',
            tasks: [{ name: 'sync', running: true }],
          }],
        }),
        updateSources: (sources: unknown[]) => schedulerUpdates.push(sources),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
        refreshSchedulerSources: () => [],
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'unpair_source_busy' } });
    expect(existsSync(sessionPath)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
    expect(schedulerUpdates).toEqual([]);
  });

  test('refuses a session directory an operator has pointed outside every Olympus-owned root', async () => {
    const home = fixtureHome();
    const stray = touch(join(home, 'elsewhere/whatsapp/session.db'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: {
          homeDir: home,
          env: { OLYMPUS_WHATSAPP_STATE_DIR: join(home, 'elsewhere/whatsapp') },
        },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unpair_session_path_external' },
    });
    expect(existsSync(stray)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
  });

  test('is offered for paired sessions only', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'gmail.email',
      acknowledge: true,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
  });

  test('the card reads not connected afterwards, even though its indexed history still stands', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({ 'telegram.personal.session_path': sessionBase }),
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const before = await telegramCard(worker);
    expect(before.connection.state).not.toBe('not_connected');
    expect(before.connection.unpair).toMatchObject({ source_id: 'telegram.messages', label: 'Unpair Telegram' });
    // Local-only, and it says where the provider-side device is unlinked.
    expect(before.connection.unpair?.confirmation).toContain('Telegram');
    expect(before.connection.unpair?.confirmation.toLowerCase()).toContain('does not');
    // Disconnect is the broker-shaped control; a paired session gets Unpair instead.
    expect(before.connection.disconnect).toBeUndefined();

    const unpair = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));
    expect(unpair.status).toBe(200);

    const after = await telegramCard(worker);
    // The sync evidence is unchanged and still says a session existed. The
    // explicit local fact outranks it: this pairing was removed here.
    expect(after.coverage.indexed_items).toBeGreaterThan(0);
    expect(after.connection.state).toBe('not_connected');
    expect(after.connection.label).toBe('unpaired');
    expect(after.connection.action).toMatchObject({ kind: 'guided_session', label: 'Pairing required' });
    expect(after.connection.unpair).toBeUndefined();
  });
});

describe('Unpair carries the same custody proof every dashboard control does', () => {
  test('is refused without a control session, without CSRF, and cross-origin', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    const session = touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({ 'telegram.personal.session_path': sessionBase }),
        pairingSessionPathContext: { homeDir: home },
      },
    }));
    const origin = 'http://127.0.0.1:17777';
    const guarded = withWorkerBearerAuth(
      (request: Request) => worker.fetch(request),
      { authToken: 'worker-secret' },
    );
    const unpair = (headers: Record<string, string>) => new Request(`${origin}/dashboard/unpair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ source_id: 'telegram.messages', acknowledge: true }),
    });

    // No control session at all.
    expect((await guarded(unpair({ Origin: origin }))).status).toBe(401);

    const mint = await guarded(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', Origin: origin },
    }));
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const csrfToken = (await mint.json() as { csrf_token: string }).csrf_token;

    // A session, but no CSRF header.
    expect((await guarded(unpair({ Cookie: cookie, Origin: origin }))).status).toBe(403);
    // A session and a CSRF token, from somewhere else.
    expect((await guarded(unpair({
      Cookie: cookie,
      Origin: 'http://attacker.test',
      'X-Olympus-CSRF': csrfToken,
    }))).status).toBe(403);

    // Nothing was removed by any of those.
    expect(existsSync(session)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);

    const allowed = await guarded(unpair({
      Cookie: cookie,
      Origin: origin,
      'X-Olympus-CSRF': csrfToken,
    }));
    expect(allowed.status).toBe(200);
    expect(existsSync(session)).toBe(false);
  });

  test('is not reachable by the read-only dashboard token or by GET', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
      },
    }));
    const origin = 'http://127.0.0.1:17777';
    const guarded = withWorkerBearerAuth(
      (request: Request) => worker.fetch(request),
      { authToken: 'worker-secret' },
    );
    const dashboardToken = dashboardQueryTokenFromWorkerAuthToken('worker-secret')!;

    const viaViewToken = await guarded(new Request(
      `${origin}/dashboard/unpair?token=${dashboardToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ source_id: 'telegram.messages', acknowledge: true }),
      },
    ));
    expect(viaViewToken.status).toBe(401);

    // The route is declared POST-only in the public surface; a GET is not a
    // dashboard route at all.
    expect(isV04PublicDashboardRoute('GET', '/dashboard/unpair')).toBe(false);
    expect(isV04PublicDashboardRoute('POST', '/dashboard/unpair')).toBe(true);
  });
});

describe('the unpaired fact outlives the worker process', () => {
  test('a restarted worker still reads the card as unpaired over unchanged sync evidence', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const dashboard = () => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: memorySecretStore({ 'telegram.personal.session_path': sessionBase }),
      pairingSessionPathContext: { homeDir: home },
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);
    expect((await telegramCard(worker)).connection.label).toBe('unpaired');

    // A new worker over the same registry: nothing about the indexed history
    // or its timestamps changed, so anything inferred from sync evidence alone
    // would call this card connected again.
    const restarted = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    const card = await telegramCard(restarted);
    expect(card.coverage.indexed_items).toBeGreaterThan(0);
    expect(card.connection.state).toBe('not_connected');
    expect(card.connection.label).toBe('unpaired');
    expect(card.connection.unpair).toBeUndefined();
  });

  test('only the connect path clears the durable fact, and rendering never writes it', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const dashboard = () => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: secrets,
      pairingSessionPathContext: { homeDir: home },
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);
    expect(readUnpairedSources(registryPath)).toEqual({ status: 'ok', records: [{ source_id: 'telegram.messages', state: 'unpaired' }] });

    // A render must never mutate durable state: it polls every few seconds and
    // holds no grant-custody lease, so a write here could land between another
    // Unpair's read and its commit and erase the fact it had just recorded.
    // Put the registry back into the shape that used to trigger the rewrite.
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const recordPath = unpairedSourcesPath(registryPath);
    const before = readFileSync(recordPath, 'utf8');
    const rendering = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    await sourceCardFor(rendering, 'telegram.messages');
    await sourceCardFor(rendering, 'telegram.messages');
    expect(readFileSync(recordPath, 'utf8')).toBe(before);

    // The connect path that registers the new pairing is what clears it, under
    // the same lease that writes the handle.
    await connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
    });
    expect(readUnpairedSources(registryPath)).toEqual({ status: 'ok', records: [] });
    const repaired = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    const card = await telegramCard(repaired);
    expect(card.connection.label).not.toBe('unpaired');
    expect(card.connection.unpair).toMatchObject({ source_id: 'telegram.messages' });
  });
});

describe('a half-removed pairing does not leak paths to the read-only token', () => {
  test('/dashboard.json under a dash_ token names no file path', async () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const qr = touch(join(stateDir, 'qr.txt'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return whatsappFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({ 'whatsapp.personal_local.session_path': stateDir }),
        pairingSessionPathContext: { homeDir: home },
      },
    }));
    const origin = 'http://127.0.0.1:17777';
    const guarded = withWorkerBearerAuth(
      (request: Request) => worker.fetch(request),
      { authToken: 'worker-secret' },
    );
    const mint = await guarded(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', Origin: origin },
    }));
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const csrfToken = (await mint.json() as { csrf_token: string }).csrf_token;

    chmodSync(stateDir, 0o500);
    try {
      const unpair = await guarded(new Request(`${origin}/dashboard/unpair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: origin,
          'X-Olympus-CSRF': csrfToken,
        },
        body: JSON.stringify({ source_id: 'whatsapp.personal.messages', acknowledge: true }),
      }));
      expect(unpair.status).toBe(200);
      // The authorized response DOES carry them: this is the person who
      // pressed the button, and they are the only one who can finish the job.
      const authorized = await unpair.text();
      expect(authorized).toContain(sessionDb);

      const dashboardToken = dashboardQueryTokenFromWorkerAuthToken('worker-secret')!;
      const readOnly = await guarded(new Request(
        `${origin}/dashboard.json?token=${dashboardToken}`,
        { headers: { Referer: `${origin}/dashboard` } },
      ));
      expect(readOnly.status).toBe(200);
      const body = await readOnly.text();
      expect(body).toContain('Unpair incomplete');
      // Not one path, not the directory holding them, not the home they sit in.
      expect(body).not.toContain(sessionDb);
      expect(body).not.toContain(qr);
      expect(body).not.toContain(stateDir);
      expect(body).not.toContain(home);
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });
});

describe('scheduler adoption is serialized against Unpair and retried on failure', () => {
  test('an adoption interleaved with an Unpair cannot resurrect the parked lane', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const schedulerUpdates: string[][] = [];
    const gate = deferred();
    let gateArmed = false;
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceScheduler: {
        status: () => ({ enabled: true, running: false, sources: [] }),
        updateSources: (sources: Array<{ sourceId: string }>) =>
          schedulerUpdates.push(sources.map((source) => source.sourceId)),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
        registryAdoptionIntervalMs: 0,
        refreshSchedulerSources: async (handles) => {
          // Hold the first rebuild open, so an Unpair has every chance to
          // interleave with an adoption that has already read the handles.
          if (gateArmed) {
            gateArmed = false;
            await gate.promise;
          }
          return (handles ?? readConnectedHandleRegistry(registryPath).handles)
            .filter((handle) => handle.provider === 'telegram')
            .map(() => ({ sourceId: 'telegram.messages' })) as never;
        },
      },
    }));

    // Arm the gate and start an adoption that reads the PRE-Unpair registry.
    gateArmed = true;
    const adopting = sourceCardFor(worker, 'telegram.messages');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Now unpair while that rebuild is still in flight.
    const unpairing = worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.resolve();

    await adopting;
    expect((await unpairing).status).toBe(200);

    // However the two interleaved, the lane must end parked: the owner tore
    // this pairing down and nothing may put it back but a re-pair.
    expect(schedulerUpdates.at(-1)).toEqual([]);
    await sourceCardFor(worker, 'telegram.messages');
    expect(schedulerUpdates.at(-1)).toEqual([]);
  });

  test('a rebuild that fails is retried rather than stranding the lane', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const schedulerUpdates: string[][] = [];
    let attempts = 0;
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceScheduler: {
        status: () => ({ enabled: true, running: false, sources: [] }),
        updateSources: (sources: Array<{ sourceId: string }>) =>
          schedulerUpdates.push(sources.map((source) => source.sourceId)),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
        registryAdoptionIntervalMs: 0,
        refreshSchedulerSources: async (handles) => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient rebuild failure');
          return (handles ?? []).filter((handle) => handle.provider === 'telegram')
            .map(() => ({ sourceId: 'telegram.messages' })) as never;
        },
      },
    }));

    // First render: the rebuild throws, nothing is applied, and the stamp must
    // NOT advance or the lane stays wrong until an unrelated registry write.
    await sourceCardFor(worker, 'telegram.messages');
    expect(attempts).toBe(1);
    expect(schedulerUpdates).toEqual([]);

    // Second render retries the same unchanged registry and succeeds.
    await sourceCardFor(worker, 'telegram.messages');
    expect(attempts).toBe(2);
    expect(schedulerUpdates).toEqual([['telegram.messages']]);
  });
});

describe('an unreadable durable record never reads as "nothing was unpaired"', () => {
  // Every way this file can stop being readable. Each must reach the SAME
  // place: a degraded card, a 409 from Unpair, and a connect that refuses
  // before it writes anything. Reporting any of them as "nothing was ever
  // unpaired" hands the card back to its sync evidence, which is the exact
  // false "connected" the record exists to prevent.
  const damage: Array<{
    name: string;
    apply: (recordPath: string) => void;
    restore?: (recordPath: string) => void;
    /** Permission games are meaningless as root: the checks simply pass. */
    permissionOnly?: true;
  }> = [
    {
      name: 'truncated JSON',
      apply: (recordPath) => writeFileSync(recordPath, '{"version": 1, "sources": [{"source_i'),
    },
    {
      name: 'parseable but malformed entry',
      apply: (recordPath) => writeFileSync(
        recordPath,
        JSON.stringify({ version: 1, sources: [{ source_i: 'telegram.messages' }] }),
      ),
    },
    {
      name: 'entry with an unrecognized field type',
      apply: (recordPath) => writeFileSync(
        recordPath,
        JSON.stringify({ version: 1, sources: [{ source_id: 'telegram.messages', unremoved_paths: 'not-an-array' }] }),
      ),
    },
    {
      name: 'unknown record version',
      apply: (recordPath) => writeFileSync(
        recordPath,
        JSON.stringify({ version: 2, sources: [{ source_id: 'telegram.messages', state: 'unpaired' }] }),
      ),
    },
    {
      name: 'file that cannot be read',
      apply: (recordPath) => {
        writeFileSync(recordPath, JSON.stringify({ version: 1, sources: [] }));
        chmodSync(recordPath, 0o000);
      },
      restore: (recordPath) => chmodSync(recordPath, 0o600),
      permissionOnly: true,
    },
    {
      name: 'directory that cannot be traversed',
      apply: (recordPath) => {
        writeFileSync(recordPath, JSON.stringify({ version: 1, sources: [] }));
        chmodSync(dirname(recordPath), 0o000);
      },
      restore: (recordPath) => chmodSync(dirname(recordPath), 0o700),
      permissionOnly: true,
    },
    {
      // Followed and trusted by the old read, while the write side rejected it.
      name: 'symbolic link to a valid record',
      apply: (recordPath) => {
        const real = `${recordPath}.real`;
        writeFileSync(real, JSON.stringify({ version: 1, sources: [] }));
        symlinkSync(real, recordPath);
      },
    },
    {
      name: 'directory at the record path',
      apply: (recordPath) => { mkdirSync(recordPath, { recursive: true }); },
    },
  ];

  for (const scenario of damage) {
    const runningAsRoot = process.geteuid?.() === 0;
    const scenarioTest = scenario.permissionOnly && runningAsRoot ? test.skip : test;
    scenarioTest(`${scenario.name}: degraded card, 409 Unpair, connect refuses before writing`, async () => {
      const home = fixtureHome();
      const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
      const session = touch(`${sessionBase}.session`);
      const registryPath = join(home, 'registry/handles.json');
      mkdirSync(dirname(registryPath), { recursive: true });
      writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
      const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
      const worker = trackWorker(createEmailSourceWorker({
        sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
        sourceDashboard: {
          sovereigntyEngine: fixtureSovereigntyEngine(),
          registryPath,
          secretStore: secrets,
          pairingSessionPathContext: { homeDir: home },
        },
      }));
      // Read BEFORE the damage: some scenarios make the registry itself
      // unreadable, and reading it under those conditions throws for a normal
      // user and silently succeeds for root — a test that measures the damage
      // instead of the behaviour.
      const handlesBefore = readConnectedHandleRegistry(registryPath).handles.length;
      scenario.apply(unpairedSourcesPath(registryPath));
      try {
        // Never absence: the card must not fall back to inferring a live
        // session from unchanged sync evidence. Bounded, because the failure
        // this guards against is a read that never returns at all.
        const card = await withDeadline(telegramCard(worker), 5_000, scenario.name);
        expect(card.coverage.indexed_items).toBeGreaterThan(0);
        expect(card.connection.state).toBe('not_connected');
        expect(card.connection.label).toBe('unpair state unreadable');
        // And the file path never reaches the read-only view model.
        expect(JSON.stringify(card)).not.toContain(home);

        const unpair = await withDeadline(worker.fetch(jsonRequest('/dashboard/unpair', {
          source_id: 'telegram.messages',
          acknowledge: true,
        })), 5_000, scenario.name);
        expect(unpair.status).toBe(409);
        await expect(unpair.json()).resolves.toMatchObject({
          error: { code: expect.stringMatching(/^unpair_record_(unreadable|not_writable)$/) },
        });
        expect(existsSync(session)).toBe(true);

        // Connect refuses BEFORE it registers anything, so a refusal cannot
        // leave a pairing whose durable state nobody can reconcile.
        await expect(withDeadline(connectGuidedSession({
          source: 'telegram',
          sessionPath: sessionBase,
          registryPath,
          secretStore: secrets,
          sessionReady: true,
        }), 5_000, scenario.name)).rejects.toThrow(/unreadable|cannot be written|not a regular file|symbolic link/i);
      } finally {
        // Restored before the registry is read again, so the assertion below
        // measures what connect did rather than what the damage did.
        scenario.restore?.(unpairedSourcesPath(registryPath));
      }
      expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(handlesBefore);
    });
  }

  test('a record that is genuinely absent is still absence, not a refusal', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    expect(readUnpairedSources(registryPath)).toEqual({ status: 'missing' });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({ 'telegram.personal.session_path': sessionBase }),
        pairingSessionPathContext: { homeDir: home },
      },
    }));
    expect((await telegramCard(worker)).connection.label).not.toBe('unpair state unreadable');
    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);
  });
});

describe('a connect that cannot finish leaves nothing published', () => {
  // The publish and the latch clear are two writes, and the second can fail
  // after the first has landed — which left connect reporting failure while a
  // ready handle stood in the registry: adoption could activate the lane off
  // it, and the durable latch went on rendering the card unpaired.
  //
  // The fault is injected through the store's own async `set`, which is exactly
  // where a real interleaving would land: the record passes its readability
  // check, the await yields, and the record is gone by the time the clear runs.
  // No production seam is added for this — the ordering is the mechanism.
  const sabotageRecordDuring = (secrets: SecretStore, recordPath: string): void => {
    const set = secrets.set.bind(secrets);
    secrets.set = async (key, value) => {
      await set(key, value);
      rmSync(recordPath, { recursive: true, force: true });
      mkdirSync(recordPath, { recursive: true });
    };
  };

  test('a failed latch clear rolls the handle and stored path back', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    writeUnpairedSources([{ source_id: 'telegram.messages', state: 'unpaired' }], registryPath);
    const secrets = memorySecretStore({});
    sabotageRecordDuring(secrets, unpairedSourcesPath(registryPath));

    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
    })).rejects.toThrow();

    // Connect reported failure, so nothing may be left standing.
    expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
    expect(await secrets.get('telegram.personal.session_path')).toBeUndefined();
  });

  test('a rollback restores what this connect overwrote, rather than deleting it', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    writeUnpairedSources([{ source_id: 'telegram.messages', state: 'unpaired' }], registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': '/previous/session' });
    sabotageRecordDuring(secrets, unpairedSourcesPath(registryPath));

    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
    })).rejects.toThrow();

    // Restored, not removed: a failed re-pair must not read as a disconnect.
    expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle))
      .toEqual(['telegram.personal']);
    expect(await secrets.get('telegram.personal.session_path')).toBe('/previous/session');
  });

  test('a rollback that itself fails says so and names the repair', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    writeUnpairedSources([{ source_id: 'telegram.messages', state: 'unpaired' }], registryPath);
    const secrets = memorySecretStore({});
    sabotageRecordDuring(secrets, unpairedSourcesPath(registryPath));
    // The rollback's own undo is the second thing to fail.
    secrets.delete = async () => { throw new Error('secret store unreachable'); };

    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
    })).rejects.toThrow(/could not undo itself/i);
  });
});

describe('a post-rename failure is rolled back like any other', () => {
  // The atomic writer renames and then fsyncs the directory, so a call can
  // reject AFTER the new contents are already in place. Nothing may be left
  // published on that path either, which means the snapshot — not whether the
  // call threw — is what the rollback restores from.
  const failAfterWriting = (secrets: SecretStore, sabotage: () => void): void => {
    const set = secrets.set.bind(secrets);
    secrets.set = async (key, value) => {
      await set(key, value);
      sabotage();
    };
  };

  test('a secret write that lands and then rejects is restored to its prior value', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    writeUnpairedSources([{ source_id: 'telegram.messages', state: 'unpaired' }], registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': '/previous/session' });
    const set = secrets.set.bind(secrets);
    // One-shot: the publish's write lands and then rejects, while the
    // rollback's restoring write is allowed to succeed.
    let failed = false;
    secrets.set = async (key, value) => {
      await set(key, value);
      if (failed) return;
      failed = true;
      throw new Error('EIO after rename');
    };

    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
    })).rejects.toThrow();

    // Restored from the snapshot, not left at the value the failed call wrote.
    expect(await secrets.get('telegram.personal.session_path')).toBe('/previous/session');
    expect(readUnpairedSources(registryPath)).toEqual({
      status: 'ok',
      records: [{ source_id: 'telegram.messages', state: 'unpaired' }],
    });
  });

  test('a latch clear that lands and then rejects is put back', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    const priorRecord = [{
      source_id: 'telegram.messages',
      state: 'unpair_incomplete' as const,
      failed_steps: ['connected_handle'],
    }];
    writeUnpairedSources(priorRecord, registryPath);
    const secrets = memorySecretStore({});

    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
      // The record IS replaced, and the call rejects anyway — the fsync-after-
      // rename case. Everything published up to here has to come back.
      clearUnpairedSource: (sourceId, path) => {
        clearUnpairedSource(sourceId, path);
        throw new Error('EIO after rename');
      },
    })).rejects.toThrow();

    // Restoring the handle and the secret while leaving the latch cleared is
    // the worst of the three: the pairing is gone and nothing says so, so the
    // card goes back to reading its unchanged sync evidence as a live session.
    expect(readUnpairedSources(registryPath)).toEqual({ status: 'ok', records: priorRecord });
    expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
    expect(await secrets.get('telegram.personal.session_path')).toBeUndefined();
  });

  test('a rollback whose secret restore fails still restores the latch and keeps its paths', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    const owed = join(home, '.local/share/olympus/telegram/stuck.session');
    touch(owed);
    writeUnpairedSources([{
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      unremoved_paths: [owed],
    }], registryPath);
    const secrets = memorySecretStore({});
    // The secret restore is the one that fails; the latch restore must still be
    // attempted rather than skipped by a short-circuiting chain.
    secrets.delete = async () => { throw new Error('secret store unreachable'); };

    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
      clearUnpairedSource: (sourceId, path) => {
        clearUnpairedSource(sourceId, path);
        throw new Error('EIO after rename');
      },
    })).rejects.toThrow(/could not undo itself/i);

    // The prior obligation is still there. Writing a bare generic step over the
    // top would have dropped it, and a later Unpair could then discharge that
    // step without ever seeing the artifact still sitting on disk.
    const record = readUnpairedSources(registryPath);
    expect(record.status).toBe('ok');
    expect(record.status === 'ok' && record.records).toEqual([{
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      unremoved_paths: [owed],
      // Named per component, so the failure says which half could not be undone.
      failed_steps: ['connect_rollback_secret'],
    }]);
    expect(existsSync(owed)).toBe(true);
  });

  test('a first pairing that fails leaves no latch it never had', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    const secrets = memorySecretStore({});
    const set = secrets.set.bind(secrets);
    let failed = false;
    secrets.set = async (key, value) => {
      await set(key, value);
      if (failed) return;
      failed = true;
      throw new Error('EIO after rename');
    };

    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
    })).rejects.toThrow();

    // `missing` is restored as missing: a file that never existed is a
    // different fact from one saying nothing is unpaired.
    expect(readUnpairedSources(registryPath)).toEqual({ status: 'missing' });
    expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
  });
});

describe('an unpaired lane is not rebuilt by an unrelated registry change', () => {
  const laneWorker = (home: string, registryPath: string, updates: string[][]) => trackWorker(
    createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceScheduler: {
        status: () => ({ enabled: true, running: false, sources: [] }),
        updateSources: (sources: Array<{ sourceId: string }>) =>
          updates.push(sources.map((source) => source.sourceId)),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
        registryAdoptionIntervalMs: 0,
        // The production callback filters its own override; this stand-in is
        // the unfiltered kind, so the worker's own gate is what must hold.
        refreshSchedulerSources: (handles) =>
          (handles ?? []).filter((handle) => handle.provider === 'telegram')
            .map(() => ({ sourceId: 'telegram.messages' })) as never,
      },
    }),
  );

  test('an outstanding obligation keeps the lane parked across an unrelated change', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    // The handle the teardown could not remove is still here, on purpose.
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    writeUnpairedSources([{
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      failed_steps: ['connected_handle'],
    }], registryPath);
    const updates: string[][] = [];
    const worker = laneWorker(home, registryPath, updates);

    // An unrelated registry change — another source connecting — is what used
    // to bypass the check that boot had honoured.
    writeConnectedHandleRegistry({
      version: 1,
      handles: [telegramHandle(), dropboxHandle()],
    }, registryPath);
    await sourceCardFor(worker, 'telegram.messages');

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)).toEqual([]);
  });

  test('an unreadable record keeps the lane parked across an unrelated change', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    writeFileSync(unpairedSourcesPath(registryPath), '{"version": 1, "sources": [{"source_i');
    const updates: string[][] = [];
    const worker = laneWorker(home, registryPath, updates);

    writeConnectedHandleRegistry({
      version: 1,
      handles: [telegramHandle(), dropboxHandle()],
    }, registryPath);
    await sourceCardFor(worker, 'telegram.messages');

    // Not knowing whether a source was unpaired is not permission to read it.
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)).toEqual([]);
  });

  test('a re-paired source does get its lane back', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    writeUnpairedSources([{ source_id: 'telegram.messages', state: 'unpaired' }], registryPath);
    const updates: string[][] = [];
    const worker = laneWorker(home, registryPath, updates);
    await sourceCardFor(worker, 'telegram.messages');
    expect(updates.at(-1)).toEqual([]);

    // The gate is the record, and only a connect clears it.
    writeUnpairedSources([], registryPath);
    writeConnectedHandleRegistry({
      version: 1,
      handles: [telegramHandle(), dropboxHandle()],
    }, registryPath);
    await sourceCardFor(worker, 'telegram.messages');
    expect(updates.at(-1)).toEqual(['telegram.messages']);
  });
});

describe('an obligation recorded by another attempt is never overwritten', () => {
  test('a run writing from a stale view does not erase a newer obligation', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const newerObligation = touch(join(home, '.local/share/olympus/telegram/other-profile.session'));

    // Another attempt records a custom path AFTER this run has read the record
    // and while it is mid-teardown. The final write must union against the file
    // as it stands, not replay this run's stale snapshot over the top.
    const remove = secrets.delete.bind(secrets);
    let injected = false;
    secrets.delete = async (key) => {
      await remove(key);
      if (injected) return;
      injected = true;
      writeUnpairedSources([{
        source_id: 'telegram.messages',
        state: 'unpair_incomplete',
        unremoved_paths: [newerObligation],
      }], registryPath);
    };

    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));
    expect(response.status).toBe(200);

    // This run's own artifacts are discharged; the other attempt's obligation
    // survives, because nothing is removed unless it was proven finished.
    const record = readUnpairedSources(registryPath);
    expect(record.status).toBe('ok');
    expect(record.status === 'ok' && record.records).toEqual([{
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      unremoved_paths: [newerObligation],
    }]);
    expect((await telegramCard(worker)).connection.label)
      .toBe('Unpair incomplete — manual cleanup required');
  });
});

describe('an obligation survives the attempt that could not discharge it', () => {
  test('a retry after a stuck handle does not narrow to a clean unpaired', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    const session = touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const dashboard = (removeConnectedHandles?: () => never) => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: secrets,
      pairingSessionPathContext: { homeDir: home },
      ...(removeConnectedHandles ? { removeConnectedHandles } : {}),
    });

    // First attempt: artifacts deleted, handle stuck.
    const first = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(() => { throw new Error('registry write refused'); }),
    }));
    expect((await first.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);
    expect(existsSync(session)).toBe(false);

    // Second attempt, still stuck, and now with NOTHING left on disk to plan.
    // The record used to be replaced by a fresh in-progress one describing only
    // what this run could see — an empty path list — which then reconciled
    // straight to a clean `unpaired` while the handle still stood.
    const second = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(() => { throw new Error('registry write refused'); }),
    }));
    const retry = await second.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      failed_steps: ['connected_handle'],
      policy: { session_removal_complete: false, connected_handle_removed: false },
    });
    expect(readUnpairedSources(registryPath)).toEqual({
      status: 'ok',
      records: [{
        source_id: 'telegram.messages',
        state: 'unpair_incomplete',
        failed_steps: ['connected_handle'],
      }],
    });

    // A restart must still read incomplete, and must not rebuild the lane off
    // the handle the teardown could not remove.
    const restarted = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    expect((await telegramCard(restarted)).connection.label)
      .toBe('Unpair incomplete — manual cleanup required');
    expect(unpairedLaneProviders(registryPath).has('telegram')).toBe(true);
  });

  test('an artifact a previous attempt could not remove stays owed when this run cannot see it', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    // The session was reconfigured between attempts, so the path the first
    // attempt could not delete is not in anything this run resolves. Only the
    // record knows it is still owed — and it is still there.
    const stray = touch(join(home, '.local/share/olympus/telegram/old-profile.session'));
    writeUnpairedSources([{
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      unremoved_paths: [stray],
    }], registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      unremoved_session_paths: [stray],
      policy: { session_removal_complete: false },
    });
    // Not narrowed away by a run that simply could not see it.
    expect(readUnpairedSources(registryPath)).toEqual({
      status: 'ok',
      records: [{
        source_id: 'telegram.messages',
        state: 'unpair_incomplete',
        unremoved_paths: [stray],
      }],
    });
    expect((await telegramCard(worker)).connection.label)
      .toBe('Unpair incomplete — manual cleanup required');
  });

  test('an obligation whose artifact is genuinely gone is discharged', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    writeUnpairedSources([{
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      unremoved_paths: [join(home, '.local/share/olympus/telegram/removed-by-hand.session')],
    }], registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);

    // Carrying it forever would be the mirror-image lie: asking the owner to
    // remove a file that is not there.
    expect(readUnpairedSources(registryPath)).toEqual({
      status: 'ok',
      records: [{ source_id: 'telegram.messages', state: 'unpaired' }],
    });
  });

  test('a retry that can finally remove the handle discharges the obligation', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const dashboard = (removeConnectedHandles?: () => never) => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: secrets,
      pairingSessionPathContext: { homeDir: home },
      ...(removeConnectedHandles ? { removeConnectedHandles } : {}),
    });
    const first = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(() => { throw new Error('registry write refused'); }),
    }));
    expect((await first.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);

    const second = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    const retry = await second.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      policy: { session_removal_complete: true, connected_handle_removed: true },
    });
    // Converged: every obligation discharged by the step that owned it.
    expect(readUnpairedSources(registryPath)).toEqual({
      status: 'ok',
      records: [{ source_id: 'telegram.messages', state: 'unpaired' }],
    });
    expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
  });

  test('an unreadable record keeps every paired-session lane from being rebuilt', () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeFileSync(unpairedSourcesPath(registryPath), '{"version": 1, "sources": [{"source_i');
    // Not knowing whether a source was unpaired is not permission to start
    // reading it again.
    expect([...unpairedLaneProviders(registryPath)].sort())
      .toEqual(['telegram', 'whatsapp_personal']);
  });
});

describe('a registry write that fails after deletion is a named failed step', () => {
  test('an unremovable handle keeps the unpair incomplete rather than reporting success', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    const session = touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const dashboard = () => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: secrets,
      pairingSessionPathContext: { homeDir: home },
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: {
        ...dashboard(),
        // The registry write refuses only at this step. It runs after the
        // artifacts are already deleted, and the writes on either side of it
        // share the same directory, so this is the one failure that cannot be
        // produced from outside without breaking those too.
        removeConnectedHandles: () => { throw new Error('registry write refused'); },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      removed_handles: [],
      failed_steps: ['connected_handle'],
      policy: {
        session_removal_complete: false,
        connected_handle_removed: false,
        local_pairing_session_removed: true,
      },
    });

    // The session really is gone, and the record says work is outstanding, so
    // the stale handle cannot quietly reconcile back to a clean unpaired once
    // the paths are absent and rebuild the lane after a restart.
    expect(existsSync(session)).toBe(false);
    expect(readUnpairedSources(registryPath)).toEqual({
      status: 'ok',
      records: [{
        source_id: 'telegram.messages',
        state: 'unpair_incomplete',
        failed_steps: ['connected_handle'],
      }],
    });
    const restarted = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    expect((await telegramCard(restarted)).connection.label)
      .toBe('Unpair incomplete — manual cleanup required');
  });
});

describe('a named pipe at the record path cannot hang the worker', () => {
  test('the real reader returns unreadable instead of blocking forever', async () => {
    // A FIFO blocks readFileSync until a writer appears, and that read is
    // synchronous: it would freeze the event loop, so no in-process timeout
    // could ever fire to catch it. The only honest bound is another process
    // that the parent can time out and kill.
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    const recordPath = unpairedSourcesPath(registryPath);
    execFileSync('mkfifo', [recordPath]);
    const probe = join(home, 'probe.ts');
    writeFileSync(probe, [
      `import { readUnpairedSources } from ${JSON.stringify(join(import.meta.dir, '../src/workers/credential-broker/unpaired-sources.ts'))};`,
      'const read = readUnpairedSources(process.argv[2]!);',
      'console.log(JSON.stringify({ status: read.status }));',
      '',
    ].join('\n'));

    const child = Bun.spawn(['bun', probe, registryPath], { stdout: 'pipe', stderr: 'pipe' });
    let timedOut = false;
    // Generous: this bounds a hang, it does not measure spawn latency.
    const killer = setTimeout(() => { timedOut = true; child.kill(); }, 25_000);
    let stdout: string;
    try {
      stdout = await new Response(child.stdout).text();
      await child.exited;
    } finally {
      clearTimeout(killer);
    }

    expect(timedOut).toBe(false);
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ status: 'unreadable' });
  }, 30_000);
});

describe('the worker can be put down', () => {
  test('close() stops the background adoption tick', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    let rebuilds = 0;
    const worker = trackWorker(createEmailSourceWorker({
      sourceScheduler: {
        status: () => ({ enabled: true, running: false, sources: [] }),
        updateSources: () => {},
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
        registryAdoptionIntervalMs: 5,
        refreshSchedulerSources: (handles) => {
          rebuilds += 1;
          return (handles ?? []).map(() => ({ sourceId: 'telegram.messages' })) as never;
        },
      },
    }));

    // Waited for, not slept through: a fixed sleep makes this test a race
    // against whatever else the machine is doing.
    await waitUntil(() => rebuilds > 0);
    expect(rebuilds).toBeGreaterThan(0);

    worker.close();
    // Idempotent: a shutdown path that runs twice is not an error.
    worker.close();
    const settled = rebuilds;
    // Move the registry so a live tick would certainly have work to do. Nothing
    // may pick it up: close() stops the ticks AND any adoption already in
    // flight, so this assertion does not depend on how long we wait.
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(rebuilds).toBe(settled);
  });
});

describe('reconciliation does not mistake an unreadable artifact for a deleted one', () => {
  test('an outstanding path that cannot be inspected keeps the record incomplete', () => {
    const record = {
      source_id: 'whatsapp.personal.messages',
      state: 'unpair_incomplete' as const,
      unremoved_paths: ['/data/session.db'],
    };
    expect(reconcileUnpairedSource(record, () => 'gone')).toEqual({
      source_id: 'whatsapp.personal.messages',
      state: 'unpaired',
    });
    // EACCES/EIO are unknowns, and an unknown in front of a completion claim
    // is not a completion.
    expect(reconcileUnpairedSource(record, () => 'unknown')).toEqual(record);
    expect(reconcileUnpairedSource(record, () => 'present')).toEqual(record);
  });

  test('a recorded failed step is never reconciled away by looking at files', () => {
    expect(reconcileUnpairedSource({
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      failed_steps: ['stored_reference'],
    }, () => 'gone')).toEqual({
      source_id: 'telegram.messages',
      state: 'unpair_incomplete',
      failed_steps: ['stored_reference'],
    });
  });
});

describe('a teardown that cannot finish still tells the truth', () => {
  test('a stored reference that will not delete leaves no handle claiming a live session', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    const session = touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    secrets.delete = async () => { throw new Error('secret store unreachable'); };
    const dashboard = () => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: secrets,
      pairingSessionPathContext: { homeDir: home },
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed_steps: ['stored_reference'],
      policy: {
        session_removal_complete: false,
        stored_reference_removed: false,
        local_pairing_session_removed: true,
      },
    });
    // The session really is gone, so nothing may keep claiming it is there.
    expect(existsSync(session)).toBe(false);
    expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);

    const live = await telegramCard(worker);
    expect(live.connection.state).toBe('not_connected');
    expect(live.connection.label).toBe('Unpair incomplete — manual cleanup required');

    const restarted = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    const afterRestart = await telegramCard(restarted);
    expect(afterRestart.connection.state).toBe(live.connection.state);
    expect(afterRestart.connection.label).toBe(live.connection.label);
  });

  test('the durable latch exists even when there was nothing on disk to delete', async () => {
    const home = fixtureHome();
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    // No session files at all: the plan is empty, and the pessimistic write
    // used to be skipped entirely while the reference and handle were still
    // deleted — a teardown with no latch behind it.
    const secrets = memorySecretStore({ 'telegram.personal.session_path': join(home, '.local/share/olympus/telegram/telegram.personal') });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);

    expect(readUnpairedSources(registryPath)).toEqual({
      status: 'ok',
      records: [{ source_id: 'telegram.messages', state: 'unpaired' }],
    });
  });
});

describe('two spellings of one registered session are not a conflict', () => {
  test('a base and its .session file stored under two keys unpair cleanly', async () => {
    const home = fixtureHome();
    const base = join(home, '.local/share/olympus/telegram/telegram.personal');
    const session = touch(`${base}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({
      'telegram.personal.session_path': base,
      'telegram.work.session_path': `${base}.session`,
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    expect(existsSync(session)).toBe(false);
  });

  test('a WhatsApp state dir and its session.db stored under two keys unpair cleanly', async () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const secrets = memorySecretStore({
      'whatsapp.personal_local.session_path': stateDir,
      'whatsapp.work_local.session_path': sessionDb,
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    expect(existsSync(sessionDb)).toBe(false);
  });

  test('two genuinely different sessions still refuse', async () => {
    const home = fixtureHome();
    const first = touch(join(home, '.local/share/olympus/telegram/one.session'));
    const second = touch(join(home, '.local/share/olympus/telegram/two.session'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({
      'telegram.personal.session_path': join(home, '.local/share/olympus/telegram/one'),
      'telegram.work.session_path': join(home, '.local/share/olympus/telegram/two'),
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unpair_session_path_conflict' },
    });
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });
});

describe('a re-pair puts the parked lane back without a restart', () => {
  test('the running scheduler regains the source after the CLI re-pairs it', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const schedulerUpdates: string[][] = [];
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceScheduler: {
        status: () => ({ enabled: true, running: false, sources: [] }),
        updateSources: (sources: Array<{ sourceId: string }>) =>
          schedulerUpdates.push(sources.map((source) => source.sourceId)),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
        // The real lane gate: no handle, no source. Same shape as
        // schedulerSourcesForHandles in the server.
        refreshSchedulerSources: (handles) =>
          (handles ?? readConnectedHandleRegistry(registryPath).handles)
            .filter((handle) => handle.provider === 'telegram')
            .map(() => ({ sourceId: 'telegram.messages' })) as never,
      },
    }));

    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);
    // Parked.
    expect(schedulerUpdates.at(-1)).toEqual([]);

    // Re-paired from the CLI, in a process with no channel into this worker.
    await connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
      sessionReady: true,
    });

    // The worker's own tick notices the registry moved and re-adopts the lane.
    await sourceCardFor(worker, 'telegram.messages');
    expect(schedulerUpdates.at(-1)).toEqual(['telegram.messages']);

    // Idempotent: an unchanged registry does no further work.
    const settled = schedulerUpdates.length;
    await sourceCardFor(worker, 'telegram.messages');
    expect(schedulerUpdates.length).toBe(settled);
  });
});

describe('a re-pair that is not yet usable reads the same before and after a restart', () => {
  test('a connect without a ready session keeps the durable and live states agreeing', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    const dashboard = () => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: secrets,
      pairingSessionPathContext: { homeDir: home },
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);

    // Pairing started, login not completed: the handle is reauth_required, so
    // there is no usable session behind it.
    await connectGuidedSession({
      source: 'telegram',
      sessionPath: sessionBase,
      registryPath,
      secretStore: secrets,
    });

    // The durable record must NOT have been cleared, or a restart would read
    // differently from the live worker that still holds the fact.
    expect(readUnpairedSources(registryPath)).toEqual({ status: 'ok', records: [{ source_id: 'telegram.messages', state: 'unpaired' }] });
    const live = await telegramCard(worker);
    const restarted = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));
    const afterRestart = await telegramCard(restarted);
    expect(afterRestart.connection.state).toBe(live.connection.state);
    expect(afterRestart.connection.label).toBe(live.connection.label);
    expect(afterRestart.connection.state).toBe('not_connected');
  });
});

describe('a run that died before its narrowing write converges', () => {
  test('a stale in-progress record naming deleted files reads clean and is committed clean', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    // Exactly what a process killed between its deletes and its final commit
    // leaves behind: the pessimistic record, naming files that are now gone.
    writeUnpairedSources([{
      source_id: 'telegram.messages',
      state: 'unpair_in_progress',
      unremoved_paths: [`${sessionBase}.session`, `${sessionBase}.session-journal`],
    }], registryPath);
    const secrets = memorySecretStore({});
    const dashboard = () => ({
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath,
      secretStore: secrets,
      pairingSessionPathContext: { homeDir: home },
    });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return telegramFixtureStatus(); } },
      sourceDashboard: dashboard(),
    }));

    // Rendering reconciles against the disk and reports the plain fact — it
    // must not ask the owner to remove files that are not there — but it holds
    // no lease, so it does not rewrite the record.
    const before = readFileSync(unpairedSourcesPath(registryPath), 'utf8');
    const card = await telegramCard(worker);
    expect(card.connection.label).toBe('unpaired');
    expect(readFileSync(unpairedSourcesPath(registryPath), 'utf8')).toBe(before);

    // The next Unpair holds the lease, so it is what commits the clean record.
    expect((await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }))).status).toBe(200);
    expect(readUnpairedSources(registryPath)).toEqual({ status: 'ok', records: [{ source_id: 'telegram.messages', state: 'unpaired' }] });
  });
});

describe('the owned-root fence is about where a delete lands, not how the path reads', () => {
  test('refuses a state directory that is a symlink out of the owned root, and deletes nothing', async () => {
    const home = fixtureHome();
    const outside = join(home, 'srv/other-data');
    const stranger = touch(join(outside, 'session.db'));
    // ~/.local/share/olympus/whatsapp-live -> ~/srv/other-data
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    mkdirSync(dirname(stateDir), { recursive: true });
    symlinkSync(outside, stateDir);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unpair_session_path_external' },
    });
    // The whole point: lexical containment said this was ours.
    expect(existsSync(stranger)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
  });

  test('works when the data home is relocated with a symlink, deleting only inside the canonical tree', () => {
    // ~/.local -> a real directory elsewhere. A common, legitimate layout: the
    // lexical root string is not where the data is, and refusing on
    // realpath(root) != root would break every owner who moves their data home.
    const home = fixtureHome();
    const relocated = join(home, 'volume/local');
    mkdirSync(join(relocated, 'share/olympus/whatsapp-live'), { recursive: true });
    symlinkSync(relocated, join(home, '.local'));
    const sessionDb = touch(join(relocated, 'share/olympus/whatsapp-live/session.db'));

    const planned = planPairingSessionRemoval(
      whatsappPairingSessionPaths({ homeDir: home }),
      { homeDir: home },
    );

    expect(planned.ok).toBe(true);
    // Canonical, not lexical: the plan names where the delete actually lands.
    expect(planned.ok === true && planned.plan.targets.map((target) => target.path))
      .toEqual([join(home, '.local/share/olympus/whatsapp-live/session.db')]);
    expect(planned.ok === true && removePlannedPairingSessionFile(planned.plan.targets[0]!)).toBe('removed');
    expect(existsSync(sessionDb)).toBe(false);
  });

  test('refuses a symlinked ancestor whose canonical path escapes the canonical root', () => {
    // The escape the canonical fence exists for: the ancestor resolves outside
    // every Olympus-owned tree, however the lexical string reads.
    const home = fixtureHome();
    const relocated = join(home, 'volume/local');
    mkdirSync(join(relocated, 'share/olympus'), { recursive: true });
    symlinkSync(relocated, join(home, '.local'));
    const stranger = touch(join(home, 'srv/other-data/session.db'));
    symlinkSync(join(home, 'srv/other-data'), join(relocated, 'share/olympus/whatsapp-live'));

    const planned = planPairingSessionRemoval(
      whatsappPairingSessionPaths({ homeDir: home }),
      { homeDir: home },
    );

    expect(planned.ok).toBe(false);
    expect(existsSync(stranger)).toBe(true);
  });

  test('refuses an ancestor swapped for a symlink between validation and deletion', () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const planned = planPairingSessionRemoval([sessionDb], { homeDir: home });
    expect(planned.ok).toBe(true);
    const target = planned.ok ? planned.plan.targets[0]! : undefined;
    expect(target).toBeDefined();

    // The classic swap: the validated directory is moved aside and a link to
    // someone else's directory takes its name, after the checks have passed.
    const stranger = touch(join(home, 'srv/other-data/session.db'));
    renameSync(stateDir, join(home, '.local/share/olympus/whatsapp-live.moved'));
    symlinkSync(join(home, 'srv/other-data'), stateDir);

    expect(() => removePlannedPairingSessionFile(target!)).toThrow(PairingSessionPathError);
    expect(existsSync(stranger)).toBe(true);
  });

  test('refuses a symlinked pairing artifact rather than following it', () => {
    const home = fixtureHome();
    const stranger = touch(join(home, 'srv/other-data/session.db'));
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(stranger, join(stateDir, 'session.db'));

    const planned = planPairingSessionRemoval([join(stateDir, 'session.db')], { homeDir: home });

    expect(planned.ok).toBe(false);
    expect(planned.ok === false && planned.refusal.reason).toBe('symlink_component');
    expect(existsSync(stranger)).toBe(true);
  });
});

describe('a registered session path is the authority over the env default', () => {
  test('deletes the custom Telegram session the pairing was registered with', async () => {
    const home = fixtureHome();
    const customBase = join(home, '.local/share/olympus/custom/tg-personal');
    const session = touch(`${customBase}.session`);
    const journal = touch(`${customBase}.session-journal`);
    // The default location holds an unrelated leftover that must be left alone.
    const defaultSession = touch(join(home, '.local/share/olympus/telegram/telegram.personal.session'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': customBase });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      removed_session_paths: [journal, session].sort(),
      policy: { local_pairing_session_removed: true, session_removal_complete: true },
    });
    expect(existsSync(session)).toBe(false);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(defaultSession)).toBe(true);
  });

  test('deletes the custom WhatsApp state directory the pairing was registered with', async () => {
    const home = fixtureHome();
    const customDir = join(home, '.local/share/olympus/custom/wa');
    const sessionDb = touch(join(customDir, 'session.db'));
    const qr = touch(join(customDir, 'qr.txt'));
    const spool = touch(join(customDir, 'spool/0001.jsonl'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const secrets = memorySecretStore({ 'whatsapp.personal_local.session_path': customDir });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      removed_session_paths: [qr, sessionDb].sort(),
    });
    expect(existsSync(sessionDb)).toBe(false);
    expect(existsSync(spool)).toBe(true);
  });

  test('accepts an env override and a stored path that spell the same session differently', async () => {
    // Telethon takes a BASE and appends `.session`; QUICKSTART's own example
    // passes the `.session` file. Two spellings of one session must not read as
    // two sessions — that turned an ordinary install into a permanent 409.
    const home = fixtureHome();
    const base = join(home, '.local/share/olympus/custom/tg');
    const session = touch(`${base}.session`);
    const journal = touch(`${base}.session-journal`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': `${base}.session` });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: {
          homeDir: home,
          // The base spelling, against the stored `.session` spelling.
          env: { OLYMPUS_TELEGRAM_SESSION_PATH: base },
        },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      removed_session_paths: [journal, session].sort(),
      policy: { session_removal_complete: true },
    });
    expect(existsSync(session)).toBe(false);
  });

  test('accepts a WhatsApp override and stored value that spell the same state dir differently', async () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/custom/wa');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const secrets = memorySecretStore({ 'whatsapp.personal_local.session_path': sessionDb });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: {
          homeDir: home,
          env: { OLYMPUS_WHATSAPP_STATE_DIR: stateDir },
        },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    expect(existsSync(sessionDb)).toBe(false);
  });

  test('refuses when an env override names a different session than the registered one', async () => {
    const home = fixtureHome();
    const registered = join(home, '.local/share/olympus/custom/tg-personal');
    const session = touch(`${registered}.session`);
    const overridden = join(home, '.local/share/olympus/other/tg');
    const overriddenSession = touch(`${overridden}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': registered });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: {
          homeDir: home,
          env: { OLYMPUS_TELEGRAM_SESSION_PATH: overridden },
        },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unpair_session_path_conflict' },
    });
    expect(existsSync(session)).toBe(true);
    expect(existsSync(overriddenSession)).toBe(true);
    expect(await secrets.get('telegram.personal.session_path')).toBe(registered);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
  });
});

describe('a registered session path is found without a registry handle', () => {
  test('deletes the custom Telegram session when no handle names it', async () => {
    const home = fixtureHome();
    const customBase = join(home, '.local/share/olympus/custom/tg-personal');
    const session = touch(`${customBase}.session`);
    const journal = touch(`${customBase}.session-journal`);
    const defaultSession = touch(join(home, '.local/share/olympus/telegram/telegram.personal.session'));
    const registryPath = join(home, 'handles.json');
    // No handle at all: the normal state for a paired session, and the case
    // where the handle-derived key list is empty and the default path used to
    // win over the one the owner actually registered.
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': customBase });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      removed_handles: [],
      removed_session_paths: [journal, session].sort(),
      policy: { session_removal_complete: true },
    });
    expect(existsSync(session)).toBe(false);
    expect(existsSync(defaultSession)).toBe(true);
    // The reference is gone too, whether or not a handle ever named it.
    expect(await secrets.get('telegram.personal.session_path')).toBeUndefined();
  });

  test('finds a WhatsApp pairing registered under a non-default account role', async () => {
    const home = fixtureHome();
    const customDir = join(home, '.local/share/olympus/custom/wa-work');
    const sessionDb = touch(join(customDir, 'session.db'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    // Not the canonical key: only listing the store finds this one.
    const secrets = memorySecretStore({ 'whatsapp.work_local.session_path': customDir });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      removed_session_paths: [sessionDb],
    });
    expect(existsSync(sessionDb)).toBe(false);
    expect(await secrets.get('whatsapp.work_local.session_path')).toBeUndefined();
  });
});

describe('an artifact that cannot be inspected is never reported as absent', () => {
  test('refuses when a component cannot be read, rather than claiming a clean removal', async () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const secrets = memorySecretStore({ 'whatsapp.personal_local.session_path': stateDir });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    // No execute permission: lstat of anything inside fails with EACCES, which
    // used to be swallowed and read as "the artifact is not there".
    chmodSync(stateDir, 0o000);
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
        source_id: 'whatsapp.personal.messages',
        acknowledge: true,
      }));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'unpair_session_path_unreadable' },
      });
      expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
      expect(await secrets.get('whatsapp.personal_local.session_path')).toBe(stateDir);
    } finally {
      chmodSync(stateDir, 0o700);
    }
    expect(existsSync(sessionDb)).toBe(true);
  });
});

describe('the durable latch is committed before the irreversible teardown', () => {
  test('refuses before deleting anything when the record cannot be written', async () => {
    const home = fixtureHome();
    const sessionBase = join(home, '.local/share/olympus/telegram/telegram.personal');
    const session = touch(`${sessionBase}.session`);
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(telegramHandle()), registryPath);
    const secrets = memorySecretStore({ 'telegram.personal.session_path': sessionBase });
    // Something other than a regular file where the record belongs: the write
    // would fail AFTER the session was deleted, which is the ordering this
    // refusal exists to make impossible.
    mkdirSync(unpairedSourcesPath(registryPath), { recursive: true });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'telegram.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unpair_record_not_writable' },
    });
    expect(existsSync(session)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
    expect(await secrets.get('telegram.personal.session_path')).toBe(sessionBase);
  });
});

describe('validation happens before any deletion', () => {
  test('a directory where a session file belongs refuses with every artifact still present', async () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const qr = touch(join(stateDir, 'qr.txt'));
    // session.db-wal is a DIRECTORY: refused, and it is validated after the
    // session.db that would otherwise already be gone.
    mkdirSync(join(stateDir, 'session.db-wal'), { recursive: true });
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const secrets = memorySecretStore({ 'whatsapp.personal_local.session_path': stateDir });
    const worker = trackWorker(createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unpair_session_path_not_a_file' },
    });
    expect(existsSync(sessionDb)).toBe(true);
    expect(existsSync(qr)).toBe(true);
    expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(1);
    expect(await secrets.get('whatsapp.personal_local.session_path')).toBe(stateDir);
  });

  test('an unlink that fails after the preflight reports partial removal and still unpairs', async () => {
    const home = fixtureHome();
    const stateDir = join(home, '.local/share/olympus/whatsapp-live');
    const sessionDb = touch(join(stateDir, 'session.db'));
    const qr = touch(join(stateDir, 'qr.txt'));
    const registryPath = join(home, 'handles.json');
    writeConnectedHandleRegistry(registryOf(whatsappHandle()), registryPath);
    const secrets = memorySecretStore({ 'whatsapp.personal_local.session_path': stateDir });
    const worker = trackWorker(createEmailSourceWorker({
      sourceIndexStatus: { async status() { return whatsappFixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        pairingSessionPathContext: { homeDir: home },
      },
    }));

    // A real mid-run failure: the artifacts pass the preflight (lstat needs
    // only +x on the directory) and then cannot be unlinked, because removing a
    // name requires write on the directory holding it.
    chmodSync(stateDir, 0o500);
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/unpair', {
        source_id: 'whatsapp.personal.messages',
        acknowledge: true,
      }));

      expect(response.status).toBe(200);
      const payload = await response.json() as { status_message: string };
      expect(payload).toMatchObject({
        ok: true,
        removed_session_paths: [],
        unremoved_session_paths: [qr, sessionDb].sort(),
        policy: {
          local_pairing_session_removed: false,
          session_removal_complete: false,
        },
      });
      // The browser prints this verbatim, so it must not read as a completion.
      expect(payload.status_message).toContain('Unpair incomplete');
      expect(payload.status_message).toContain(sessionDb);
      expect(existsSync(sessionDb)).toBe(true);
      // The teardown still happened and is reported honestly: leaving the
      // handle, the stored reference and a connected-looking card behind
      // would be the worst of both answers.
      expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
      expect(await secrets.get('whatsapp.personal_local.session_path')).toBeUndefined();
      const card = await sourceCardFor(worker, 'whatsapp.personal.messages');
      expect(card.connection.state).toBe('not_connected');
      // The card says work is outstanding without printing where: this model is
      // served to the read-only token, which is promised no file paths. The
      // paths are in the POST response above, which only the person who pressed
      // the button — holding the control session — can read.
      expect(card.connection.label).toBe('Unpair incomplete — manual cleanup required');
      // Durable too: a restart must not forget that work is outstanding.
      expect(readUnpairedSources(registryPath)).toEqual({
        status: 'ok',
        records: [{
          source_id: 'whatsapp.personal.messages',
          state: 'unpair_incomplete',
          unremoved_paths: [qr, sessionDb].sort(),
        }],
      });
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });
});

describe('pairing session paths', () => {
  test('name the session artifacts only, never the spool or media that carry message text', () => {
    const context = { homeDir: '/home/fixture' };
    expect(whatsappPairingSessionPaths(context)).toEqual([
      '/home/fixture/.local/share/olympus/whatsapp-live/session.db',
      '/home/fixture/.local/share/olympus/whatsapp-live/session.db-wal',
      '/home/fixture/.local/share/olympus/whatsapp-live/session.db-shm',
      '/home/fixture/.local/share/olympus/whatsapp-live/qr.txt',
    ]);
    expect(telegramPairingSessionPaths(context)).toEqual([
      '/home/fixture/.local/share/olympus/telegram/telegram.personal.session',
      '/home/fixture/.local/share/olympus/telegram/telegram.personal.session-journal',
    ]);
  });

  test('refuse a configured path that escapes every Olympus-owned root', () => {
    const home = fixtureHome();
    const inside = touch(join(home, '.local/share/olympus/whatsapp-live/session.db'));
    const outside = touch(join(home, 'elsewhere/session.db'));

    const allowed = planPairingSessionRemoval([inside], { homeDir: home });
    expect(allowed.ok).toBe(true);
    expect(allowed.ok === true && allowed.plan.targets.map((target) => target.path)).toEqual([inside]);

    const refused = planPairingSessionRemoval([outside], { homeDir: home });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.refusal.reason).toBe('outside_root');
  });

  test('treat an artifact that does not exist as nothing to do, not a refusal', () => {
    const home = fixtureHome();
    const planned = planPairingSessionRemoval(
      whatsappPairingSessionPaths({ homeDir: home }),
      { homeDir: home },
    );
    expect(planned.ok).toBe(true);
    expect(planned.ok === true && planned.plan.targets).toEqual([]);
    expect(planned.ok === true && planned.plan.absent.length).toBe(4);
  });
});

interface TelegramCardView {
  coverage: { indexed_items: number };
  connection: {
    state: string;
    label: string;
    action: { kind: string; label: string };
    disconnect?: unknown;
    unpair?: { source_id: string; label: string; confirmation: string };
  };
}

async function telegramCard(worker: { fetch(request: Request): Promise<Response> }): Promise<TelegramCardView> {
  return sourceCardFor(worker, 'telegram.messages');
}

async function sourceCardFor(
  worker: { fetch(request: Request): Promise<Response> },
  sourceId: string,
): Promise<TelegramCardView> {
  const response = await worker.fetch(new Request('http://worker.test/dashboard.json'));
  expect(response.status).toBe(200);
  const view = await response.json() as { sources: Array<{ source_id: string } & TelegramCardView> };
  const card = view.sources.find((source) => source.source_id === sourceId);
  if (!card) throw new Error(`${sourceId} card missing from the dashboard view`);
  return card;
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fixtureHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-unpair-'));
  dirs.push(dir);
  return dir;
}

function touch(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'fixture');
  return path;
}

function registryOf(handle: ConnectedCredentialHandle): ConnectedHandleRegistry {
  return { version: 1, handles: [handle] };
}

function telegramHandle(): ConnectedCredentialHandle {
  return {
    handle: 'telegram.personal',
    provider: 'telegram',
    sessionKind: 'mtproto_session',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['telegram.messages.sync'],
    scopes: [],
    tokenSecretRefs: ['store:telegram.personal.session_path'],
    backendState: {
      kind: 'mtproto_session',
      status: 'available',
      mtprotoProfileId: 'telegram_personal',
      runtimeEndpointId: 'telegram_local_telethon_reader',
      library: 'telethon',
      backendLabel: 'local_private:telegram_telethon_reader',
    },
    connectedAt: '2026-08-30T10:00:00.000Z',
  };
}

/** An unrelated source, so a registry change can be about something else. */
function dropboxHandle(): ConnectedCredentialHandle {
  return {
    handle: 'dropbox.personal',
    provider: 'dropbox',
    accountRole: 'personal',
    trustDomain: 'internal',
    allowedCapabilities: ['dropbox.files.sync'],
    scopes: [],
    tokenSecretRefs: ['store:dropbox.personal.oauth.refresh_token'],
    connectedAt: '2026-08-30T10:00:00.000Z',
  };
}

function whatsappHandle(): ConnectedCredentialHandle {
  return {
    handle: 'whatsapp.personal_local',
    provider: 'whatsapp_personal',
    sessionKind: 'local_app_database',
    accountRole: 'personal_local',
    trustDomain: 'secure_local',
    allowedCapabilities: ['whatsapp.personal.messages.sync'],
    scopes: [],
    tokenSecretRefs: ['store:whatsapp.personal_local.session_path'],
    backendState: {
      kind: 'local_app_database',
      status: 'available',
      databaseSourceId: 'whatsapp_personal_local',
      readerWorker: 'whatsapp_local_reader',
      databaseRole: 'messages_readonly',
      scopeLabel: 'personal_messages',
      backendLabel: 'local_private:whatsapp_local_app_reader',
    },
    connectedAt: '2026-08-30T10:00:00.000Z',
  };
}

function whatsappFixtureStatus(): SourceIndexStatusResult {
  return chatFixtureStatus('secure_local.whatsapp.messages', 'whatsapp_personal', 'secure_local');
}

function telegramFixtureStatus(): SourceIndexStatusResult {
  return chatFixtureStatus('internal.telegram.messages', 'telegram', 'internal');
}

function chatFixtureStatus(corpusId: string, provider: string, trustDomain: string): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-08-24T00:00:00.000Z',
    corpora: [{
      corpus_id: corpusId,
      family: 'chat',
      trust_domain: trustDomain,
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider,
      counts: {
        accounts: 1,
        indexed_items: 1200,
        files_with_text: 1200,
        secure_local_chunks: 2400,
        embedded_chunks: 2400,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'item_metadata_not_requested',
    }],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as unknown as SourceIndexStatusResult;
}

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}

function memorySecretStore(initial: Record<string, string>): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    label: 'memory',
    get: async (key) => values.get(key),
    getSync: (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
    list: async () => [...values.keys()].sort(),
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition did not hold before the deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
