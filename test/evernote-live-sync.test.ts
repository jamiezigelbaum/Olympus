// The live Evernote source in the engine, against the fake Evernote MCP server
// only: a pass stores notes through the tier lane and records what it saw only
// when it completed; a pass whose listing cannot finish changes nothing; a
// refused sign-in marks the handle for Reconnect; the dashboard's Connect
// signs in through the MCP server; the card shows what the last pass counted.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { McpSourceError } from '../src/core/mcp-source/errors.ts';
import { McpCallPacer } from '../src/core/mcp-source/pacer.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { readConnectedHandleRegistry, type ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { computerOpenTargets } from '../src/workers/dashboard/host-page.ts';
import { renderDashboardKeysPage } from '../src/workers/dashboard/pages/local.ts';
import { dashboardSubLine } from '../src/workers/dashboard/vocabulary.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { EVERNOTE_HANDLE, startEvernoteSignIn } from '../src/workers/evernote/live-sync.ts';
import { createEvernoteRuntime, evernoteDashboardPass, evernoteSchedulerFailure } from '../src/workers/evernote/runtime.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { SourceSchedulerTaskFailure } from '../src/workers/source-scheduler.ts';
import { planStoreEmbedding } from '../src/workers/connector-store/embedding-plan.ts';
import { childProviderItemId } from '../src/core/child-item-id.ts';
import { embedPendingChunks } from '../src/workers/connector-store/local-index.ts';
import { evernoteAttachmentKeys } from '../src/workers/evernote/connector.ts';
import { RecordingProvider } from './helpers/tier-fixtures.ts';
import { FakeEvernoteServer, md5Hex } from './support/evernote-mcp-fake.ts';

let fake: FakeEvernoteServer | undefined;
const dirs: string[] = [];
afterEach(() => {
  fake?.stop();
  fake = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const day = (year: number, month = 1, date = 1): number => Date.UTC(year, month - 1, date, 12);

function memorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();
  return {
    label: 'memory',
    async get(key) { return secrets.get(key); },
    getSync(key) { return secrets.get(key); },
    async set(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
    async list() { return [...secrets.keys()].sort(); },
  };
}

function home(): { env: Record<string, string>; registryPath: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'evernote-live-')));
  dirs.push(base);
  return {
    env: { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') },
    registryPath: join(base, 'handles.json'),
  };
}

/** A connected account: the real sign-in against the fake, so the credential and handle are what Connect writes. */
async function connected(server: FakeEvernoteServer) {
  const { env, registryPath } = home();
  const secretStore = memorySecretStore();
  const signIn = await startEvernoteSignIn({
    serverUrl: server.url,
    authorizationHosts: ['127.0.0.1'],
    redirectUri: 'http://127.0.0.1:9/oauth/callback/evernote',
    state: 'state-1',
    secretStore,
    registryPath,
  });
  const handle = await signIn.complete('good-code');
  const runtime = createEvernoteRuntime({
    env,
    secretStore: () => secretStore,
    registryPath,
    serverUrl: server.url,
    downloadHosts: ['127.0.0.1'],
    pacer: new McpCallPacer({ minIntervalMs: 0 }),
  });
  return { env, registryPath, secretStore, handle, runtime, sync: runtime.liveSync(handle) };
}

describe('a pass through the tier lane', () => {
  test('stores the notes, records the pass only once it completed, and reads nothing unchanged again', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const book = fake.addNotebook('Field work');
    const survey = fake.addNote({ title: 'Survey', created: day(2024), notebookId: book.id, body: '<en-note>River survey</en-note>', tags: ['river'] });
    const gone = fake.addNote({ title: 'Draft', created: day(2024, 2), notebookId: book.id, body: '<en-note>Draft</en-note>' });
    fake.addNote({ title: 'Shared with me', created: day(2024, 3) });
    const { sync, runtime } = await connected(fake);

    const first = await sync.pass();
    expect(first.counts).toMatchObject({ notes_listed: 3, notebooks: 1, notes_read: 2, shared_not_imported: 1, pass_complete: 1 });
    expect(first.counts.items_indexed).toBe(2);
    expect(sync.status()).toMatchObject({ counts: { notes_listed: 3, shared_not_imported: 1 } });
    expect(sync.status()?.last_completed_at).toBeDefined();
    expect(runtime.dashboardPass()).toMatchObject({ notes: 3, notebooks: 1, shared_not_imported: 1 });
    // No source-level tier: an ordinary note is judged by its own content and rests in the Personal store.
    const identity = { provider: 'evernote', accountScope: 'personal', providerItemId: survey.id };
    const lane = runtime.existingLane()!;
    expect(lane.internal.open().storedItemState(identity)).toMatchObject({ tombstoned: false });
    expect(lane.secure.open().storedItemState(identity)?.tombstoned ?? true).toBe(true);

    const second = await sync.pass();
    expect(second.counts).toMatchObject({ notes_read: 0, notes_unchanged: 2, items_indexed: 0 });

    fake.notes.splice(fake.notes.indexOf(gone), 1);
    const third = await sync.pass();
    expect(third.counts).toMatchObject({ notes_deleted: 1, items_tombstoned: 1 });
  });

  test('a pass whose listing cannot finish changes nothing and says so on the card', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const book = fake.addNotebook('Field work');
    const kept = fake.addNote({ title: 'Survey', created: day(2024), notebookId: book.id, body: '<en-note>River</en-note>' });
    const { sync, runtime } = await connected(fake);
    await sync.pass();
    const completedAt = sync.status()?.last_completed_at;

    // The note is gone, but the notebook listing fails: nothing may be deleted.
    fake.notes.splice(fake.notes.indexOf(kept), 1);
    fake.failTool = 'search_notebooks';
    await expect(sync.pass()).rejects.toMatchObject({ name: 'EvernoteListingIncomplete' });
    expect(sync.status()).toMatchObject({ last_completed_at: completedAt, last_error: { kind: 'listing_incomplete' } });
    expect(runtime.dashboardPass()).toMatchObject({ notes: 1, error: { kind: 'listing_incomplete' } });

    // The listing works again, and the note goes now that both listings completed.
    fake.failTool = undefined;
    const next = await sync.pass();
    expect(next.counts).toMatchObject({ notes_deleted: 1, items_tombstoned: 1 });
  });

  test('a pass that stops after storing some notes still deletes them once they are gone', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const book = fake.addNotebook('Field work');
    const notes = Array.from({ length: 55 }, (_, index) => fake!.addNote({ title: `Note ${index}`, created: day(2024, 1, index + 1), notebookId: book.id, body: `<en-note>Note ${index}</en-note>` }));
    const { sync, runtime } = await connected(fake);
    const stored = (noteId: string) => runtime.existingLane()?.set.storedItem({ provider: 'evernote', accountScope: 'personal', providerItemId: noteId }, (a, b) => a.localeCompare(b));

    // The first page of notes is stored, then the server breaks.
    fake.breakGetNoteAfter = 52;
    await expect(sync.pass()).rejects.toBeDefined();
    expect(sync.status()?.last_completed_at).toBeUndefined();
    const storedNote = [notes[0]!, notes[54]!].find((note) => stored(note.id) !== undefined)!;
    expect(storedNote).toBeDefined();

    // The oldest and the newest note go before the next pass completes. Notes are read in date
    // order, so one of them was in the stored page and the other was never read.
    fake.breakGetNoteAfter = undefined;
    for (const note of [notes[0]!, notes[54]!]) fake.notes.splice(fake.notes.indexOf(note), 1);
    const next = await sync.pass();
    expect(next.counts).toMatchObject({ notes_deleted: 1, pass_complete: 1 });
    expect(stored(storedNote.id)).toBeUndefined();
    const after = await sync.pass();
    expect(after.counts).toMatchObject({ notes_deleted: 0, notes_unchanged: 53 });
  });

  test('a reconnect to another account stops before deleting the stored notes, and the card says why', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const book = fake.addNotebook('Field work');
    const kept = fake.addNote({ title: 'Survey', created: day(2024), notebookId: book.id, body: '<en-note>River</en-note>' });
    const { sync, runtime } = await connected(fake);
    await sync.pass();

    // Same credential, another account: its notebooks share none with the stored notes.
    fake.notes.splice(fake.notes.indexOf(kept), 1);
    fake.notebooks.splice(0, fake.notebooks.length);
    const theirs = fake.addNotebook('Field work');
    fake.addNote({ title: 'Theirs', created: day(2025), notebookId: theirs.id, body: '<en-note>Other</en-note>' });
    await expect(sync.pass()).rejects.toMatchObject({ name: 'EvernoteAccountChanged' });
    expect(sync.status()).toMatchObject({ last_error: { kind: 'account_changed' } });
    expect(runtime.dashboardPass()).toMatchObject({ error: { kind: 'account_changed' } });
    const stored = runtime.existingLane()!.set.storedItem({ provider: 'evernote', accountScope: 'personal', providerItemId: kept.id }, (a, b) => a.localeCompare(b));
    expect(stored?.tombstoned).not.toBe(true);
    expect(stored).toBeDefined();
  });

  test('a sign-in the provider refuses marks the handle for Reconnect', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    fake.addNote({ title: 'Survey', created: day(2024), notebookId: fake.addNotebook('A').id });
    const { sync, registryPath, runtime } = await connected(fake);
    fake.refreshRevoked = true;
    fake.expireAccessToken();
    await expect(sync.pass()).rejects.toMatchObject({ kind: 'auth_revoked' });
    const handle = readConnectedHandleRegistry(registryPath).handles.find((entry) => entry.handle === EVERNOTE_HANDLE);
    expect(handle?.backendState?.status).toBe('reauth_required');
    expect(runtime.dashboardPass()).toMatchObject({ error: { kind: 'auth' } });
  });
});

describe('the scheduler source', () => {
  test('one pass task at the scheduler interval, and one attachment read for the whole lane', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const { runtime, handle } = await connected(fake);
    const source = runtime.schedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 3600, freshnessThresholdHours: 26 } } } as never,
      handle,
    });
    expect(source.sourceId).toBe('evernote.notes');
    expect(source.intervalMs).toBe(3_600_000);
    expect(source.tasks.map((task) => task.id)).toEqual([
      'evernote.notes_pass',
      'evernote.attachments.secure_local.evernote.notes',
    ]);
    // Before the pass has opened a store there is nothing to read.
    expect(await source.tasks[1]!.run()).toEqual({ status: 'idle', counts: {} });
    const run = await source.tasks[0]!.run();
    expect(run.counts).toMatchObject({ pass_complete: 1 });
  });

  test('an attachment of an ordinary note is read and its text lands, whichever store the note rests in', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const book = fake.addNotebook('Field work');
    const bytes = new TextEncoder().encode('fixtureferryword: the ferry leaves the quay at seven.');
    const note = fake.addNote({ title: 'Timetable', created: day(2024), notebookId: book.id, body: '<en-note>Ferry times</en-note>', resources: [{ bytes, mime: 'text/plain', name: 'timetable.txt' }] });
    const { runtime, handle } = await connected(fake);
    const source = runtime.schedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 3600, freshnessThresholdHours: 26 } } } as never,
      handle,
    });
    expect((await source.tasks[0]!.run()).counts).toMatchObject({ pass_complete: 1 });
    for (const task of source.tasks.slice(1)) await task.run();
    const child = `personal:${childProviderItemId(note.id, evernoteAttachmentKeys([md5Hex(bytes)])[0]!)}`;
    const lane = runtime.existingLane()!;
    const text = [lane.secure.open(), lane.internal.open()].flatMap((store) => store.localContent(child)?.chunks ?? []).join(' ');
    expect(text).toContain('fixtureferryword');
  });

  test('a note routed to the Personal store gets its vectors from the store-wide sweep, though no pass queued it', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    fake.addNote({ title: 'Survey', created: day(2024), notebookId: fake.addNotebook('Field work').id, body: '<en-note>River survey</en-note>' });
    const { sync, runtime } = await connected(fake);
    await sync.pass();
    const internal = runtime.existingLane()!.internal.open();
    // The pass stages in the Private store and routes per item: nothing queues the Personal copy.
    expect(internal.queuedEmbeddingItemIds()).toEqual([]);
    const provider = new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
    const target = planStoreEmbedding({ store: internal, provider, servedByMeaning: true, scope: { allowed: true } })!;
    expect(target.wholeStore).toBe(true);
    const [run] = await embedPendingChunks([target], { maxItems: 32 });
    expect(run!.chunksEmbedded).toBeGreaterThan(0);
  });

  test('a rate-limited pass retries later; a refused sign-in is a credential failure', () => {
    const limited = evernoteSchedulerFailure(new McpSourceError('rate_limited', { retryAfterMs: 60_000 }));
    expect(limited).toBeInstanceOf(SourceSchedulerTaskFailure);
    expect((limited as SourceSchedulerTaskFailure).retryAt?.degradedReason).toBe('rate_limited');
    const revoked = evernoteSchedulerFailure(new McpSourceError('auth_revoked'));
    expect((revoked as SourceSchedulerTaskFailure).errorKind).toBe('credential_missing');
  });
});

describe('the dashboard', () => {
  test('Connect signs in through the MCP server with no client id, and the callback stores the handle', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const { registryPath } = home();
    const secretStore = memorySecretStore();
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath,
        secretStore,
        evernoteSignIn: { serverUrl: fake.url, authorizationHosts: ['127.0.0.1'] },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
    const start = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'evernote' }),
    }));
    expect(start.status).toBe(200);
    const authorization = new URL((await start.json() as { authorization_url: string }).authorization_url);
    expect(authorization.origin).toBe(fake.origin);
    expect(authorization.searchParams.get('scope')).toBe('read');
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://worker.test/oauth/callback/evernote');
    const state = authorization.searchParams.get('state')!;

    // A callback with another state is refused and stores nothing.
    const forged = await fetch(new Request('http://worker.test/oauth/callback/evernote?code=good-code&state=forged'));
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);

    const restart = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'evernote' }),
    }));
    const retryState = new URL((await restart.json() as { authorization_url: string }).authorization_url).searchParams.get('state')!;
    expect(retryState).not.toBe(state);
    const callback = await fetch(new Request(`http://worker.test/oauth/callback/evernote?code=good-code&state=${retryState}`));
    expect(callback.status).toBe(303);
    const handle = readConnectedHandleRegistry(registryPath).handles[0] as ConnectedCredentialHandle;
    expect(handle).toMatchObject({ handle: EVERNOTE_HANDLE, provider: 'evernote', scopes: ['read'], allowedCapabilities: ['evernote.notes.sync'] });
    expect(handle.tokenSecretRefs).toEqual(['store:evernote.personal.mcp_credential']);
    expect(await secretStore.get('evernote.personal.mcp_credential')).toBeDefined();
  });

  test('the panel\'s Connect opens the computer\'s Evernote row, whose button starts the sign-in route', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: { generated_at: '2026-10-28T12:00:00.000Z', corpora: [] } as never,
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    const row = buildChatGptDashboardViewModel(view, {}).sources.find((source) => source.id === 'evernote.notes')!;
    expect(row.primary).toMatchObject({ label: 'Connect', href: 'https://olympusplugin.ai/open/connect/evernote/', openHref: true });
    // On the computer that link is the Keys page, landed on Evernote's row.
    expect(computerOpenTargets('http://127.0.0.1:8787')['connect/evernote']).toBe('http://127.0.0.1:8787/dashboard?keys#olympus-open=connect.evernote');
    const keys = renderDashboardKeysPage(view, {});
    const at = keys.indexOf('data-source-id="evernote.notes"');
    expect(at).toBeGreaterThan(0);
    // The row's Connect posts { source: 'evernote' } to /dashboard/connect/oauth/start (start_oauth).
    expect(keys.slice(at, keys.indexOf('</div>', at))).toContain('data-connect-kind="oauth"><input type="hidden" name="source" value="evernote">');
  });

  test('the card offers one Connect, then says what the last pass counted', () => {
    const view = (livePasses?: Parameters<typeof buildSourceDashboardViewModel>[0]['livePasses']) => buildSourceDashboardViewModel({
      sourceIndexStatus: { generated_at: '2026-10-28T12:00:00.000Z', corpora: [] } as never,
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      now: new Date('2026-10-28T12:00:00.000Z'),
      ...(livePasses ? { livePasses } : {}),
    });
    const card = view().sources.find((source) => source.source_id === 'evernote.notes')!;
    expect(card.label).toBe('Evernote');
    expect(card.connection.action).toEqual({ kind: 'oauth', source: 'evernote', label: 'Connect', publisher_client: true });
    // One Evernote card: the ENEX exports show on it, not on a second card.
    expect(view().sources.filter((source) => source.provider === 'evernote').map((source) => source.source_id)).toEqual(['evernote.notes']);

    const pass = evernoteDashboardPass({
      last_completed_at: '2026-10-28T11:00:00.000Z',
      counts: { notes_listed: 1204, notebooks: 12, shared_not_imported: 3 } as never,
    })!;
    const withPass = view({ 'evernote.notes': pass }).sources.find((source) => source.source_id === 'evernote.notes')!;
    expect(withPass.live_pass).toEqual({ completed_at: '2026-10-28T11:00:00.000Z', notes: 1204, notebooks: 12, shared_not_imported: 3 });
    const fresh = { ...withPass, connection: { ...withPass.connection, state: 'synced' as const }, configured: true, answer_readiness: { state: 'ready' as const, label: 'Ready for questions' } };
    expect(dashboardSubLine(fresh, { now: new Date('2026-10-28T12:00:00.000Z') }))
      .toContain('1,204 notes in 12 notebooks · 3 shared with you, not imported');
    // A pass that ran out of its budget resumes on its own: nothing to say.
    expect(evernoteDashboardPass({ last_completed_at: '2026-10-28T11:00:00.000Z', last_error: { kind: 'budget_exhausted', state: 'paused', at: '2026-10-28T11:00:00.000Z' } })?.error).toBeUndefined();
  });
});
