// The dashboard's side of importing an archive, synthetic files only: the
// picker's archive mode (files beside folders, never a link; folder mode is
// unchanged), an approval that answers at once and reads a possible copy in
// the background ("checking", then "already imported" or the import started),
// Decline, Remove, and the Archives row's list; the dashboard routes, which
// only a control session reaches. Then one archive from the picker to the
// Archives row and a search hit cited as imported mail, and back out, and an
// import whose content stays held while the private model is stopped.

import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isV04PublicDashboardRoute } from '../src/core/public-surface.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { createArchiveImportDashboard, type ArchivePrivateModelState } from '../src/workers/archive-import/dashboard.ts';
import { runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { ArchiveImportRequestStore, archiveImportRequestsPath } from '../src/workers/archive-import/requests.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { withArchiveImportCorpora } from '../src/workers/archive-import/store.ts';
import { pullArchiveImport } from '../src/workers/archive-import/sync.ts';
import { MacPermissions } from '../src/workers/local-files/mac-permissions.ts';
import { createLocalFilesArchiveBrowser, createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function mail(index: number, input: { subject?: string; body?: string; tag?: string } = {}): string {
  const tag = input.tag ?? 'a';
  return [
    'From: Sam Example <sam@example.invalid>',
    'To: Alex Example <alex@example.invalid>',
    `Subject: ${input.subject ?? `Synthetic ${tag} note ${index}`}`,
    `Date: Mon, ${String(5 + index).padStart(2, '0')} Jan 2015 10:00:00 +0000`,
    `Message-ID: <${tag}-${index}@example.invalid>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.body ?? `The synthetic ${tag} harbour log, entry ${index}.`,
  ].join('\n');
}

/** A message with one attached file: its name is kept, its bytes are not read. */
function withAttachment(index: number): string {
  return [
    'From: Sam Example <sam@example.invalid>',
    'To: Alex Example <alex@example.invalid>',
    `Subject: Synthetic attachment note ${index}`,
    `Date: Mon, ${String(5 + index).padStart(2, '0')} Jan 2015 10:00:00 +0000`,
    `Message-ID: <attach-${index}@example.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The synthetic tide table is attached.',
    '--b1',
    'Content-Type: application/pdf; name="tides.pdf"',
    'Content-Disposition: attachment; filename="tides.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--b1--',
  ].join('\n');
}

function mbox(messages: readonly string[]): string {
  return messages.map((message) => `From sender@example.invalid Mon Jan  5 10:00:00 2015\n${message}\n\n`).join('');
}

function fixture(options: { model?: ArchivePrivateModelState } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-dashboard-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const exports = join(home, 'Mail exports');
  mkdirSync(exports, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
  });
  const volumes = new VolumeResolver({
    platform: 'darwin',
    home,
    readMounts: () => '/dev/disk3s1s1 on / (apfs, local)',
    diskutilPlist: () => undefined,
  });
  // Off a Mac the Mac's privacy rules do not apply; a Mac's are covered by the scope browser's own tests.
  const permissions = new MacPermissions({ home, memoryPath: join(base, 'folder-access.json'), platform: 'linux' });
  const browser = createLocalFilesArchiveBrowser({ volumes, home, permissions });
  const folders = createLocalFilesFolderScopeBrowser({ volumes, home, permissions });
  let refreshes = 0;
  let model: ArchivePrivateModelState = options.model ?? 'ready';
  // A check reads a slice, then waits here: held, it stays "checking" until released.
  let hold: Promise<void> | undefined;
  let release = () => undefined as void;
  const dashboard = createArchiveImportDashboard({
    runtime,
    browser,
    refreshScheduler: () => { refreshes += 1; },
    privateModel: () => model,
    pause: () => hold ?? Promise.resolve(),
    home,
  });
  cleanups.push(() => dashboard.close());
  const write = (name: string, text: string, folder = exports): string => {
    const path = join(folder, name);
    writeFileSync(path, text);
    return path;
  };
  return {
    base, home, exports, env, runtime, browser, folders, dashboard, write,
    refreshes: () => refreshes,
    setModel: (next: ArchivePrivateModelState) => { model = next; },
    holdChecks: () => { hold = new Promise<void>((resolve) => { release = resolve; }); },
    releaseChecks: () => { hold = undefined; release(); },
  };
}

async function importAll(runtime: ArchiveImportRuntime, archiveId: string): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    const outcome = await pullArchiveImport({ state: runtime.state, lane: runtime.lane('email'), archiveId });
    if (!outcome.continueSoon) return;
  }
  throw new Error('the import did not finish');
}

async function approveKey(f: ReturnType<typeof fixture>, path: string) {
  return f.dashboard.approve({ key: path });
}

describe('the archive picker', () => {
  test('offers files beside folders, an Apple Mail .mbox folder as one choice, never a link or a hidden file; folder mode is unchanged', async () => {
    const f = fixture();
    f.write('Takeout.mbox', mbox([mail(0)]));
    f.write('.hidden.mbox', mbox([mail(1)]));
    mkdirSync(join(f.exports, 'Inbox.mbox'));
    f.write('mbox', mbox([mail(2)]), join(f.exports, 'Inbox.mbox'));
    symlinkSync(join(f.exports, 'Takeout.mbox'), join(f.exports, 'link.mbox'));
    symlinkSync(join(f.exports, 'Inbox.mbox'), join(f.exports, 'link-folder'));

    const listed = await f.dashboard.browse({ parentKey: f.exports });
    const byName = new Map(listed.nodes.map((node) => [node.name, node]));
    expect([...byName.keys()].sort()).toEqual(['Inbox.mbox', 'Takeout.mbox']);
    expect(byName.get('Takeout.mbox')).toMatchObject({ kind: 'file', has_children: false, selectable: true, size_bytes: mbox([mail(0)]).length });
    expect(byName.get('Inbox.mbox')).toMatchObject({ kind: 'folder', has_children: true, selectable: true });

    // The folder picker for Files on this computer still lists folders only.
    const folders = await f.folders.browse({ parentKey: f.exports });
    expect(folders.nodes.map((node) => node.name)).toEqual(['Inbox.mbox']);
    expect(folders.nodes.every((node) => node.kind === 'folder')).toBe(true);

    // A key that names a link, or nothing, is refused before anything of it is read.
    expect(await f.browser.resolve(join(f.exports, 'link.mbox'))).toMatchObject({ ok: false, code: 'link' });
    expect(await f.browser.resolve(join(f.exports, 'link-folder'))).toMatchObject({ ok: false, code: 'link' });
    expect(await f.browser.resolve(join(f.exports, 'gone.mbox'))).toMatchObject({ ok: false, code: 'not_found' });
    expect(await f.dashboard.approve({ key: join(f.exports, 'link.mbox') })).toMatchObject({ ok: false, code: 'link' });
    expect(f.runtime.state.list()).toEqual([]);
  });
});

describe('approving an import', () => {
  test('a new export starts at once and is handed to the scheduler; the same file again is already imported', async () => {
    const f = fixture();
    const path = f.write('Takeout.mbox', mbox([mail(0), mail(1)]));
    const started = await approveKey(f, path);
    expect(started).toMatchObject({ ok: true, status: 'started', name: 'Takeout.mbox' });
    expect(f.refreshes()).toBe(1);
    const again = await approveKey(f, path);
    expect(again).toMatchObject({ ok: true, status: 'already_imported', name: 'Takeout.mbox', archive_name: 'Takeout.mbox' });
    expect(f.runtime.state.list()).toHaveLength(1);
  });

  test('a file Olympus does not import, or an Apple Mail folder, are told apart by what they hold', async () => {
    const f = fixture();
    const notes = f.write('notes.txt', 'shopping list');
    expect(await approveKey(f, notes)).toMatchObject({ ok: false, code: 'unsupported', message: expect.stringContaining('Mail (mbox)') });
    mkdirSync(join(f.exports, 'Inbox.mbox'));
    f.write('mbox', mbox([mail(0)]), join(f.exports, 'Inbox.mbox'));
    expect(await approveKey(f, join(f.exports, 'Inbox.mbox'))).toMatchObject({ ok: true, status: 'started', name: 'Inbox.mbox' });
  });

  test('a possible copy answers "checking" at once, then reads as already imported once its files were read whole', async () => {
    const f = fixture();
    const text = mbox([mail(0, { tag: 'big', body: 'x'.repeat(3 * 1024 * 1024) })]);
    const first = await approveKey(f, f.write('Big.mbox', text));
    if (!first.ok || first.status !== 'started') throw new Error('expected a start');
    await importAll(f.runtime, first.archive_id);

    mkdirSync(join(f.home, 'Desktop'));
    copyFileSync(join(f.exports, 'Big.mbox'), join(f.home, 'Desktop', 'Big copy.mbox'));
    f.holdChecks();
    const checking = await approveKey(f, join(f.home, 'Desktop', 'Big copy.mbox'));
    expect(checking).toMatchObject({ ok: true, status: 'checking', name: 'Big copy.mbox' });
    expect(f.dashboard.view().requests).toEqual([expect.objectContaining({ name: 'Big copy.mbox', where: '~/Desktop', origin: 'dashboard', status: 'checking' })]);
    // A second press while it checks is the same check.
    expect(await approveKey(f, join(f.home, 'Desktop', 'Big copy.mbox'))).toMatchObject({ status: 'checking' });
    expect(f.dashboard.view().requests).toHaveLength(1);
    expect(f.dashboard.decline(checking.ok && checking.status === 'checking' ? checking.request_id : '')).toMatchObject({ ok: false, code: 'checking' });

    f.releaseChecks();
    await f.dashboard.idle();
    expect(f.dashboard.view().requests).toEqual([expect.objectContaining({
      name: 'Big copy.mbox', status: 'already_imported', archiveId: first.archive_id, archiveName: 'Big.mbox',
    })]);
    expect(f.runtime.state.list()).toHaveLength(1);
    // Dismiss clears the finished check.
    const request = f.dashboard.view().requests[0]!;
    expect(f.dashboard.decline(request.id)).toEqual({ ok: true });
    expect(f.dashboard.view().requests).toEqual([]);
  });

  test('a possible copy that differs inside is started once the check has read it', async () => {
    const f = fixture();
    const text = mbox([mail(0, { tag: 'big', body: 'x'.repeat(3 * 1024 * 1024) })]);
    const first = await approveKey(f, f.write('Big.mbox', text));
    if (!first.ok || first.status !== 'started') throw new Error('expected a start');
    await importAll(f.runtime, first.archive_id);
    const refreshesBefore = f.refreshes();

    const middle = Math.floor(text.length / 2);
    const twin = f.write('Twin.mbox', `${text.slice(0, middle)}y${text.slice(middle + 1)}`);
    expect(await approveKey(f, twin)).toMatchObject({ ok: true, status: 'checking' });
    await f.dashboard.idle();
    expect(f.dashboard.view().requests).toEqual([]);
    expect(f.runtime.state.list().map((record) => record.label).sort()).toEqual(['Big.mbox', 'Twin.mbox']);
    expect(f.refreshes()).toBe(refreshesBefore + 1);
  });

  test('an agent\'s request waits for Import or Decline', async () => {
    const f = fixture();
    const path = f.write('Takeout.mbox', mbox([mail(0)]));
    const requests = new ArchiveImportRequestStore({ path: archiveImportRequestsPath(f.runtime.state.path) });
    const asked = requests.addPending(path)!;
    const declined = requests.addPending(f.write('Other.mbox', mbox([mail(1)])))!;
    expect(f.dashboard.view().requests).toEqual([
      expect.objectContaining({ id: asked.request_id, name: 'Takeout.mbox', where: '~/Mail exports', origin: 'agent', status: 'pending' }),
      expect.objectContaining({ id: declined.request_id, name: 'Other.mbox', status: 'pending' }),
    ]);
    expect(f.dashboard.decline(declined.request_id)).toEqual({ ok: true });
    expect(f.dashboard.decline(declined.request_id)).toMatchObject({ ok: false, code: 'not_waiting' });
    expect(await f.dashboard.approve({ requestId: asked.request_id })).toMatchObject({ ok: true, status: 'started', name: 'Takeout.mbox' });
    expect(f.dashboard.view().requests).toEqual([]);
    expect(await f.dashboard.approve({ requestId: asked.request_id })).toMatchObject({ ok: false, code: 'not_waiting' });
  });
});

describe('the Archives row\'s list', () => {
  test('says what each archive holds, how far it is, what waits for the private model, and exactly what was not read', async () => {
    const f = fixture({ model: 'off' });
    const spam = mail(3).replace('Content-Type: text/plain', 'X-Gmail-Labels: Spam\nContent-Type: text/plain');
    const text = mbox([mail(0), mail(1), withAttachment(2), spam]);
    const started = await approveKey(f, f.write('Takeout.mbox', text));
    if (!started.ok || started.status !== 'started') throw new Error('expected a start');
    let view = f.dashboard.view();
    expect(view).toMatchObject({ sourceId: 'archive.imports', privateModel: 'off', requests: [] });
    expect(view.archives).toEqual([expect.objectContaining({
      id: started.archive_id, name: 'Takeout.mbox', format: 'Mail (mbox)', where: '~/Mail exports', status: 'importing', items: 0, percent: 0,
    })]);
    expect(f.dashboard.present()).toEqual({ archives: 1, importing: true });

    await importAll(f.runtime, started.archive_id);
    view = f.dashboard.view();
    const entry = view.archives[0]!;
    expect(entry).toMatchObject({ status: 'imported', items: 3, earliest: '2015-01-05', latest: '2015-01-07' });
    // With no private model, every message is still held Private.
    expect(entry.held).toBe(3);
    expect(entry.judged).toBe(0);
    expect(entry.importedAt).toEqual(expect.any(String));
    expect(entry.percent).toBeUndefined();
    expect(f.dashboard.present()).toEqual({ archives: 1, importing: false });
    // What was not read, and what was left out as live Gmail leaves it out, with exactly where.
    expect(entry.gaps).toEqual([{ kind: 'attachments_not_read', count: 1 }]);
    expect(entry.skipped).toEqual([{ kind: 'spam_or_trash', count: 1 }]);
    // The third message starts where the first two end.
    expect(entry.examples).toContainEqual({ kind: 'attachments_not_read', file: 'Takeout.mbox', offset: mbox([mail(0), mail(1)]).length });

    expect(f.dashboard.remove(started.archive_id)).toEqual({ ok: true });
    expect(f.dashboard.view().archives[0]).toMatchObject({ status: 'removing' });
    expect(f.dashboard.remove(started.archive_id)).toMatchObject({ ok: false, code: 'already_removing' });
    expect(f.dashboard.remove('00000000-0000-4000-8000-000000000000')).toMatchObject({ ok: false, code: 'unknown_archive' });
  });

  test('a stopped import says which file and why', async () => {
    const f = fixture();
    const path = f.write('Takeout.mbox', mbox([mail(0), mail(1)]));
    const started = await approveKey(f, path);
    if (!started.ok || started.status !== 'started') throw new Error('expected a start');
    writeFileSync(path, mbox([mail(0), mail(1), mail(2)]));
    await importAll(f.runtime, started.archive_id);
    expect(f.dashboard.view().archives[0]).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', file: 'Takeout.mbox' } });
  });
});

describe('the dashboard routes', () => {
  test('only a control session reaches them, never the read-only token; Remove must be confirmed', async () => {
    const f = fixture();
    f.write('Takeout.mbox', mbox([mail(0)]));
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        archiveImports: f.dashboard,
      },
    });
    const origin = 'http://127.0.0.1:17777';
    const guarded = withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: 'worker-secret' });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => guarded(new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
      body: JSON.stringify(body),
    }));
    for (const route of ['browse', 'approve', 'decline', 'remove']) {
      expect(isV04PublicDashboardRoute('POST', `/dashboard/archive-import/${route}`)).toBe(true);
      expect(isV04PublicDashboardRoute('GET', `/dashboard/archive-import/${route}`)).toBe(false);
    }
    const key = join(f.exports, 'Takeout.mbox');
    // No session, or only the read-only view token: refused, and nothing recorded.
    expect((await post('/dashboard/archive-import/approve', { key })).status).toBe(401);
    expect((await post('/dashboard/archive-import/browse', {})).status).toBe(401);
    const viewToken = dashboardQueryTokenFromWorkerAuthToken('worker-secret')!;
    expect((await post(`/dashboard/archive-import/approve?token=${viewToken}`, { key })).status).toBe(401);
    expect(f.dashboard.view().archives).toEqual([]);

    const mint = await guarded(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', Origin: origin },
    }));
    const control = {
      Cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!,
      'X-Olympus-CSRF': (await mint.json() as { csrf_token: string }).csrf_token,
    };
    const listed = await post('/dashboard/archive-import/browse', { parent_key: f.exports }, control);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { nodes: Array<{ name: string }> }).nodes.map((node) => node.name)).toContain('Takeout.mbox');
    const approved = await post('/dashboard/archive-import/approve', { key }, control);
    expect(approved.status).toBe(200);
    const started = await approved.json() as { status: string; archive_id: string };
    expect(started.status).toBe('started');
    expect(f.refreshes()).toBe(1);
    // Either a choice or a request, never both or neither.
    expect((await post('/dashboard/archive-import/approve', {}, control)).status).toBe(400);

    const unconfirmed = await post('/dashboard/archive-import/remove', { archive_id: started.archive_id }, control);
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({ error: { code: 'remove_confirmation_required' } });
    expect(f.dashboard.view().archives[0]!.status).toBe('importing');
    const removed = await post('/dashboard/archive-import/remove', { archive_id: started.archive_id, acknowledge: true }, control);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(f.dashboard.view().archives[0]!.status).toBe('removing');
  });
});

describe('one archive from the picker to a cited answer and back out', () => {
  test('approve, import, find it in search cited as imported mail, remove', async () => {
    const f = fixture();
    const path = f.write('Takeout.mbox', mbox([
      mail(0, { subject: 'Lighthouse keeper rota for March', body: 'The lighthouse keeper rota for March is on the board.' }),
      mail(1),
    ]));
    const listed = await f.dashboard.browse({ parentKey: f.exports });
    const chosen = listed.nodes.find((node) => node.name === 'Takeout.mbox')!;
    const started = await f.dashboard.approve({ key: chosen.key });
    if (!started.ok || started.status !== 'started') throw new Error('expected a start');
    await importAll(f.runtime, started.archive_id);
    expect(f.dashboard.view().archives[0]).toMatchObject({ status: 'imported', items: 2 });

    // The worker's own search route, over the archive's stores, finds it.
    const lane = f.runtime.lane('email');
    const worker = createEmailSourceWorker({ connectorStores: lane.set.openStores() });
    const hits: Array<Record<string, any>> = [];
    for (const store of lane.set.openStores()) {
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'lighthouse keeper rota', corpus_id: store.corpusId, retrieval_mode: 'keyword', max_results: 5 }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { hits?: Array<Record<string, any>> };
      hits.push(...(body.hits ?? []).map((hit) => ({ ...hit, corpus: store.corpusId, trust: store.trustDomain })));
    }
    // The Archives row, from the engine's own status over these stores: one
    // archive imported, and its listing done (no "Finding items" left).
    const corpusRegistry = createSourceCorpusRegistry(withArchiveImportCorpora());
    const opened = new Set(lane.set.openStores().map((store) => store.corpusId));
    const status = await createSourceIndexStatusHandler({
      corpusDefinitions: corpusRegistry.definitions('status').filter((definition) => opened.has(definition.corpusId)),
      connectorStores: lane.set.openStores(),
    }).status({});
    const card = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sourceCorpusRegistry: corpusRegistry,
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: { version: 1, handles: [] },
      apiKeyAvailability: {},
      importedArchives: f.dashboard.present(),
    });
    expect(card.sources.find((entry) => entry.source_id === 'archive.imports')!.connection.label).toBe('1 archive imported');
    const row = buildChatGptDashboardViewModel(card, {}).sources.find((source) => source.id === 'archive.imports')!;
    expect(row.status).not.toBe('Off');
    expect(row.progress?.stage).not.toBe('listing');

    const hit = hits.find((candidate) => candidate.sourceItem?.accountScope === started.archive_id);
    expect(hit).toBeDefined();
    expect(hit!.sourceItem.provider).toBe('mbox');

    // Cited by its format, not by the dashboard row or a mail account.
    const cited = searchToolResult({
      evidence: [{ trust_domain: 'internal', provider: hit!.sourceItem.provider, family: 'email', title: 'Lighthouse keeper rota for March', excerpt: 'rota' }],
      coverage: {},
    });
    expect((cited.structuredContent as { evidence: Array<{ source: string }> }).evidence[0]!.source).toBe('Imported mail');

    // Remove: everything derived from it goes, the file stays.
    expect(f.dashboard.remove(started.archive_id)).toEqual({ ok: true });
    let removal = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: started.archive_id });
    for (let run = 0; run < 20 && removal.kind === 'progress'; run += 1) {
      removal = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: started.archive_id });
    }
    expect(removal.kind).toBe('removed');
    expect(f.dashboard.view().archives).toEqual([]);
    expect(f.dashboard.present()).toEqual({ archives: 0, importing: false });
    expect(Bun.file(path).size).toBeGreaterThan(0);
  });
});
