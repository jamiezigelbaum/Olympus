// What an agent may do about archive imports: the `archive_import` operation
// (start, status, remove). It only asks and looks. `start` and `remove` leave
// a request for the person and touch nothing of the named path; `status` is
// the dashboard's own list, in plain words, with no message text and with an
// unreadable list said as unreadable. The person's approval, on the computer's
// own dashboard, is what imports or removes: the dashboard's control routes
// take a local-grade session alone, never the worker bearer an agent holds.
// Synthetic files only; names are invented.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import {
  V0_4_HERMES_MCP_TOOLS,
  V0_4_PUBLIC_CLI_COMMANDS,
  V0_4_PUBLIC_CLI_OPERATIONS,
  V0_4_PUBLIC_MCP_TOOLS,
  V0_4_PUBLIC_NATIVE_TOOLS,
  V0_4_PUBLIC_REMOTE_MCP_TOOLS,
} from '../src/core/public-surface.ts';
import { exposedOperations, type OperationSurface } from '../src/core/operation-exposure.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import * as scopeSafe from '../src/core/scope-safe-fs.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import {
  ARCHIVE_APPROVE_TOOL_NAME,
  ARCHIVE_DECLINE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { createArchiveImportDashboard, type ArchivePrivateModelState } from '../src/workers/archive-import/dashboard.ts';
import { runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { ARCHIVE_IMPORT_PENDING_REQUESTS_MAX, archiveImportRequestsPath } from '../src/workers/archive-import/requests.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { pullArchiveImport } from '../src/workers/archive-import/sync.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';
import { createDashboardPanelTools } from '../src/workers/email-source/dashboard-panel-tools.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';
import { MacPermissions } from '../src/workers/local-files/mac-permissions.ts';
import { createLocalFilesArchiveBrowser } from '../src/workers/local-files/scope-browser.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { buildSourceDashboardViewModel, type DashboardImportedArchives } from '../src/workers/source-dashboard.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const TOKEN = 'worker-secret';
const ORIGIN = 'http://127.0.0.1:17777';
const archiveImport = operations.find((operation) => operation.name === 'archive_import')!;

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

function mbox(messages: readonly string[]): string {
  return messages.map((message) => `From sender@example.invalid Mon Jan  5 10:00:00 2015\n${message}\n\n`).join('');
}

function fixture(options: { model?: ArchivePrivateModelState } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-agent-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const exports = join(home, 'Mail exports');
  mkdirSync(exports, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const runtime: ArchiveImportRuntime = createArchiveImportRuntime({
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
  const permissions = new MacPermissions({ home, memoryPath: join(base, 'folder-access.json'), platform: 'linux' });
  const browser = createLocalFilesArchiveBrowser({ volumes, home, permissions });
  let model: ArchivePrivateModelState = options.model ?? 'ready';
  const dashboard = createArchiveImportDashboard({
    runtime,
    browser,
    refreshScheduler: () => undefined,
    privateModel: () => model,
    home,
  });
  cleanups.push(() => dashboard.close());
  const write = (name: string, text: string, folder = exports): string => {
    const path = join(folder, name);
    writeFileSync(path, text);
    return path;
  };
  // The real worker behind the real bearer boundary, and the agent's own client to it.
  const worker: ReturnType<typeof createEmailSourceWorker> = createEmailSourceWorker({
    archiveImportAgent: dashboard.agent,
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      archiveImports: dashboard,
      // The panel's tools reach the worker's own routes in-process, as they do in the engine.
      panelTools: createDashboardPanelTools({ workerFetch: (request: Request) => worker.fetch(request) } as unknown as Parameters<typeof createDashboardPanelTools>[0]),
    },
  });
  const guarded = withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: TOKEN });
  const config = defaultConfig();
  config.email.enabled = true;
  const email = new EmailClient(config, new DirectHttpEmailTransport((input, init) => guarded(new Request(input, init)), TOKEN));
  const ctx: OperationContext = { config, delphi: {} as OperationContext['delphi'], email };
  return {
    base, home, exports, env, runtime, dashboard, write, guarded, ctx,
    requestsPath: archiveImportRequestsPath(runtime.state.path),
    setModel: (next: ArchivePrivateModelState) => { model = next; },
    start: (path: unknown) => archiveImport.handler(ctx, { action: 'start', path }) as Promise<Record<string, unknown>>,
    status: (archiveId?: string) => archiveImport.handler(ctx, { action: 'status', ...(archiveId ? { archive_id: archiveId } : {}) }) as Promise<Record<string, unknown>>,
    remove: (archiveId: unknown) => archiveImport.handler(ctx, { action: 'remove', archive_id: archiveId }) as Promise<Record<string, unknown>>,
  };
}

type Fixture = ReturnType<typeof fixture>;

async function importAll(runtime: ArchiveImportRuntime, archiveId: string): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    const outcome = await pullArchiveImport({ state: runtime.state, lane: runtime.lane('email'), archiveId });
    if (!outcome.continueSoon) return;
  }
  throw new Error('the import did not finish');
}

/** The person's approval at the dashboard, then the import run to the end. */
async function imported(f: Fixture, name: string, messages: readonly string[]): Promise<{ id: string; path: string }> {
  const path = f.write(name, mbox(messages));
  const started = await f.dashboard.approve({ key: path });
  if (!started.ok || started.status !== 'started') throw new Error('expected a start');
  await importAll(f.runtime, started.archive_id);
  return { id: started.archive_id, path };
}

/**
 * Records every call that names a path through node:fs, node:fs/promises, the
 * scope-safe reader and Bun.file, calling through to the real thing. A call
 * "touches" a needle when its first argument (or, for rename, copy and link,
 * its second) names it: the data a write carries is not a path.
 */
function watchFilesystem() {
  const spies: Array<{ label: string; mock: { calls: unknown[][] } }> = [];
  const restores: Array<() => void> = [];
  const wrap = (label: string, host: object) => {
    for (const key of Object.getOwnPropertyNames(host)) {
      if (key === 'constructor' || key === 'prototype') continue;
      let candidate: unknown;
      try { candidate = (host as Record<string, unknown>)[key]; } catch { continue; }
      if (typeof candidate !== 'function' || /^[A-Z]/.test(key)) continue;
      try {
        const original = candidate as unknown as Record<string, unknown>;
        const spy = spyOn(host as Record<string, never>, key as never);
        // A wrapper keeps the original's own members (fs.realpathSync.native, for one).
        const wrapper = (host as Record<string, unknown>)[key] as Record<string, unknown>;
        for (const member of Object.getOwnPropertyNames(original)) {
          if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(member) || member in wrapper) continue;
          wrapper[member] = original[member];
        }
        spies.push({ label: `${label}.${key}`, mock: spy.mock as never });
        restores.push(() => spy.mockRestore());
      } catch { /* a read-only member cannot hold a spy; the others still do */ }
    }
  };
  wrap('fs', fs);
  wrap('fs/promises', fsp);
  wrap('scope-safe-fs', scopeSafe);
  wrap('ScopeRoot', scopeSafe.ScopeRoot);
  wrap('ScopeRoot#', scopeSafe.ScopeRoot.prototype);
  wrap('ScopeFileReader#', scopeSafe.ScopeFileReader.prototype);
  wrap('Bun', Bun);
  const named = (value: unknown, needle: string): boolean => {
    if (typeof value === 'string') return value.includes(needle);
    if (value instanceof URL) return value.pathname.includes(needle);
    if (Buffer.isBuffer(value)) return value.toString().includes(needle);
    return false;
  };
  const twoPaths = /\.(rename|copyFile|cp|link|symlink)/;
  const watching = {
    /** Every call that names any of the needles. */
    touching(...needles: string[]): string[] {
      const hits: string[] = [];
      for (const { label, mock } of spies) {
        for (const args of mock.calls) {
          const operands = twoPaths.test(label.replace(/Sync$/, '')) ? args.slice(0, 2) : args.slice(0, 1);
          if (needles.some((needle) => operands.some((operand) => named(operand, needle)))) hits.push(label);
        }
      }
      return hits;
    },
    clear() { for (const { mock } of spies) mock.calls.length = 0; },
    count: () => spies.length,
    stop() { while (restores.length) restores.pop()!(); },
  };
  cleanups.push(() => watching.stop());
  return watching;
}

describe('start asks and touches nothing', () => {
  test('the path is kept as text: needs_approval, where the person answers, and no look at the file, its folder or its name', async () => {
    const f = fixture();
    const path = f.write('Takeout.mbox', mbox([mail(0)]));
    const watch = watchFilesystem();
    // The spy is not vacuous: it sees the engine's own reads of that file, and a plain stat of it.
    expect(watch.count()).toBeGreaterThan(50);
    fs.statSync(path);
    expect(watch.touching('Takeout.mbox')).toEqual(['fs.statSync']);
    watch.clear();

    const asked = await f.start(path);
    expect(asked).toMatchObject({
      ok: false,
      code: 'needs_approval',
      open: { target: 'archives', url: 'olympus://open/archives', page: 'https://olympusplugin.ai/open/archives/' },
    });
    expect(typeof asked.request_id).toBe('string');
    // Plain words for the agent: the person answers on their computer, the file is not for the agent to open.
    expect(String(asked.message)).toContain('Takeout.mbox');
    expect(String(asked.message)).toMatch(/open Olympus on their computer/);
    expect(String(asked.message)).toMatch(/Do not open, copy or read the file yourself/);
    expect(String(asked.message)).toMatch(/call archive_import with status/);
    // Nothing named the file, its folder or its name, through any of the ways to read a path.
    expect(watch.touching(path, f.exports, 'Takeout.mbox', 'Mail exports')).toEqual([]);
    // The request is a line for the person, holding the path as text, from an agent.
    expect(f.dashboard.view().requests).toEqual([expect.objectContaining({
      id: asked.request_id, name: 'Takeout.mbox', where: '~/Mail exports', origin: 'agent', status: 'pending',
    })]);
    expect(f.runtime.state.list()).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(mbox([mail(0)]));

    // Control: the person's approval is what reads it, and the same watch sees that.
    watch.clear();
    expect(await f.dashboard.approve({ requestId: String(asked.request_id) })).toMatchObject({ ok: true, status: 'started' });
    expect(watch.touching(path, f.exports, 'Takeout.mbox').length).toBeGreaterThan(0);
  });

  test('a file, a folder, a link, a path that is not there and an odd name all get the same answer, and none is looked at', async () => {
    const f = fixture();
    const file = f.write('Takeout.mbox', mbox([mail(0)]));
    mkdirSync(join(f.exports, 'Inbox.mbox'));
    f.write('mbox', mbox([mail(1)]), join(f.exports, 'Inbox.mbox'));
    const link = join(f.exports, 'link.mbox');
    symlinkSync(file, link);
    const paths = [file, join(f.exports, 'Inbox.mbox'), link, join(f.exports, 'gone.mbox'), '/no/such/place/at/all.mbox', join(f.exports, 'a ../ b'), join(f.exports, '..', 'Other.mbox')];
    const watch = watchFilesystem();
    for (const path of paths) {
      const asked = await f.start(path);
      expect([path, asked.ok, asked.code]).toEqual([path, false, 'needs_approval']);
    }
    expect(watch.touching(f.exports, 'Takeout.mbox', 'Inbox.mbox', 'link.mbox', 'gone.mbox', '/no/such/place', 'Other.mbox')).toEqual([]);
    expect(f.dashboard.view().requests).toHaveLength(paths.length);
    expect(f.runtime.state.list()).toEqual([]);
  });

  test('the same pending path is one request; the waiting list is bounded and removals share the bound', async () => {
    const f = fixture();
    const first = await f.start('/Users/someone/Mail exports/One.mbox');
    const again = await f.start('/Users/someone/Mail exports/One.mbox');
    expect(again.request_id).toBe(first.request_id);
    expect(f.dashboard.view().requests).toHaveLength(1);

    for (let index = 1; index < ARCHIVE_IMPORT_PENDING_REQUESTS_MAX; index += 1) {
      expect(await f.start(`/Users/someone/Mail exports/Many-${index}.mbox`)).toMatchObject({ code: 'needs_approval' });
    }
    expect(f.dashboard.view().requests).toHaveLength(ARCHIVE_IMPORT_PENDING_REQUESTS_MAX);
    // The next one is refused in words, and nothing more is recorded. A path already waiting still answers.
    expect(await f.start('/Users/someone/Mail exports/Overflow.mbox')).toMatchObject({ ok: false, code: 'too_many_requests' });
    expect(await f.start('/Users/someone/Mail exports/One.mbox')).toMatchObject({ code: 'needs_approval', request_id: first.request_id });
    expect(f.dashboard.view().requests).toHaveLength(ARCHIVE_IMPORT_PENDING_REQUESTS_MAX);

    // The person answers one; there is room again.
    expect(f.dashboard.decline(String(first.request_id))).toEqual({ ok: true });
    expect(await f.start('/Users/someone/Mail exports/Overflow.mbox')).toMatchObject({ code: 'needs_approval' });
  });

  test('a path that is not a full path is refused before anything is recorded', async () => {
    const f = fixture();
    const watch = watchFilesystem();
    for (const path of ['', 'Takeout.mbox', '~/Mail exports/Takeout.mbox', './Takeout.mbox', '/Users/x/a\0b.mbox', `/${'x'.repeat(5000)}`, 7, null]) {
      const wire = await f.guarded(new Request(`${ORIGIN}/v1/archive-import/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ path }),
      }));
      expect([String(path).slice(0, 20), wire.status, (await wire.json() as { code?: string }).code]).toEqual([String(path).slice(0, 20), 200, 'invalid_path']);
    }
    // And the operation refuses a missing path or a stray argument before it leaves the process.
    await expect(archiveImport.handler(f.ctx, { action: 'start' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(archiveImport.handler(f.ctx, { action: 'start', path: '/x', archive_id: '1' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(archiveImport.handler(f.ctx, { action: 'import', path: '/x' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(archiveImport.handler(f.ctx, { action: 'start', path: '/x', approve: true })).rejects.toThrow('undeclared property: "approve"');
    expect(f.dashboard.view().requests).toEqual([]);
    expect(watch.touching('Takeout.mbox')).toEqual([]);
  });

  test('an archive the person already approved and imported is not imported again, and saying so does not look at the disk', async () => {
    const f = fixture();
    const { id, path } = await imported(f, 'Takeout.mbox', [mail(0), mail(1)]);
    const watch = watchFilesystem();
    for (const spelling of [path, `${path}/`]) {
      expect(await f.start(spelling)).toMatchObject({
        ok: true, status: 'already_imported', archive_id: id, name: 'Takeout.mbox', archive_status: 'imported',
      });
    }
    expect(watch.touching(path, f.exports, 'Takeout.mbox')).toEqual([]);
    // Nothing was asked of the person, and nothing was imported twice.
    expect(f.dashboard.view().requests).toEqual([]);
    expect(f.runtime.state.list()).toHaveLength(1);
    // A different file is a new request as usual.
    expect(await f.start(join(f.exports, 'Other.mbox'))).toMatchObject({ code: 'needs_approval' });
  });
});

describe('status carries no content and tells the truth', () => {
  test('names, counts, dates and plain lines; never a subject, a sender, a body or a message id', async () => {
    const f = fixture({ model: 'off' });
    const text = [
      mail(0, { subject: 'Zebra harbour manifest', body: 'Marmalade lighthouse invoice for the quarter.' }),
      mail(1, { subject: 'Quince tide chart', body: 'Pewter anchors at dawn.' }),
    ];
    const { id } = await imported(f, 'Takeout.mbox', text);
    await f.start(join(f.exports, 'Next.mbox'));

    const wire = await f.guarded(new Request(`${ORIGIN}/v1/archive-import/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{}',
    }));
    const raw = await wire.text();
    for (const content of ['Zebra', 'Marmalade', 'Quince', 'Pewter', 'sam@example.invalid', 'alex@example.invalid', 'Sam Example', 'a-0@example.invalid', 'Message-ID', 'Subject']) {
      expect([content, raw.includes(content)]).toEqual([content, false]);
    }
    const status = await f.status();
    expect(status).toMatchObject({ ok: true, private_model: 'off', private_model_note: expect.stringContaining('private model') });
    const archives = status.archives as Array<Record<string, unknown>>;
    expect(archives).toEqual([expect.objectContaining({
      archive_id: id,
      name: 'Takeout.mbox',
      format: 'Mail (mbox)',
      where: '~/Mail exports',
      status: 'imported',
      messages: 2,
      judged: 0,
      waiting_for_private_model: 2,
      earliest: '2015-01-05',
      latest: '2015-01-06',
      not_read: [],
      left_out: [],
      summary: expect.stringContaining('2 messages'),
    })]);
    // The same list the dashboard draws, in the same words and counts.
    const shown = f.dashboard.view().archives[0]!;
    expect([archives[0]!.messages, archives[0]!.waiting_for_private_model, archives[0]!.earliest]).toEqual([shown.items, shown.held, shown.earliest]);
    // What waits for the person is listed too: the file name and where, nothing of its contents.
    expect(status.requests).toEqual([expect.objectContaining({
      kind: 'import', name: 'Next.mbox', where: '~/Mail exports', origin: 'agent', state: 'waiting_for_approval',
      note: expect.stringContaining('Import or Decline'),
    })]);
  });

  test('a list that cannot be read is said so, never as none imported; a damaged request list leaves the archives readable', async () => {
    for (const which of ['archives', 'requests'] as const) {
      const f = fixture();
      const { id } = await imported(f, 'Takeout.mbox', [mail(0)]);
      const file = which === 'archives' ? f.runtime.state.path : f.requestsPath;
      writeFileSync(file, '{"version": 1, "archi');
      const status = await f.status();
      if (which === 'archives') {
        expect(status).toMatchObject({ ok: false, code: 'archives_unreadable', reason: 'damaged' });
        expect(status).not.toHaveProperty('archives');
        expect(String(status.message)).toMatch(/Nothing Olympus imported is deleted/);
        // Asking for an import or a removal does not pretend either: nothing is recorded, and the answer says why.
        expect(await f.start(join(f.exports, 'Next.mbox'))).toMatchObject({ ok: false, code: 'archives_unreadable' });
        expect(await f.remove(id)).toMatchObject({ ok: false, code: 'archives_unreadable' });
      } else {
        expect(status).toMatchObject({ ok: true, requests_unreadable: { reason: 'damaged' } });
        expect(status).not.toHaveProperty('requests');
        expect((status.archives as Array<{ archive_id: string }>).map((archive) => archive.archive_id)).toEqual([id]);
        expect(await f.start(join(f.exports, 'Next.mbox'))).toMatchObject({ ok: false, code: 'requests_unreadable' });
        expect(await f.remove(id)).toMatchObject({ ok: false, code: 'requests_unreadable' });
      }
      // The damaged file is left exactly as it was found.
      expect(readFileSync(file, 'utf8')).toBe('{"version": 1, "archi');
    }
  });

  test('one archive can be asked for; an id that is not an imported archive is unknown', async () => {
    const f = fixture();
    const first = await imported(f, 'One.mbox', [mail(0, { tag: 'one' })]);
    const second = await imported(f, 'Two.mbox', [mail(0, { tag: 'two' }), mail(1, { tag: 'two' })]);
    const only = await f.status(second.id);
    expect((only.archives as Array<{ archive_id: string }>).map((archive) => archive.archive_id)).toEqual([second.id]);
    expect(((await f.status()).archives as unknown[]).length).toBe(2);
    for (const id of ['6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60', 'not-an-id', '../../etc/passwd']) {
      expect(await f.status(id)).toMatchObject({ ok: false, code: 'unknown_archive' });
    }
    expect(first.id).not.toBe(second.id);
  });
});

describe('remove asks; the person\'s approval removes that archive only', () => {
  test('without approval nothing is removed and no file is touched; asking again is the same request', async () => {
    const f = fixture();
    const a = await imported(f, 'A.mbox', [mail(0, { tag: 'a' }), mail(1, { tag: 'a' })]);
    const b = await imported(f, 'B.mbox', [mail(0, { tag: 'b' })]);
    const watch = watchFilesystem();

    const asked = await f.remove(a.id);
    expect(asked).toMatchObject({
      ok: false,
      code: 'needs_approval',
      archive_id: a.id,
      name: 'A.mbox',
      open: { target: 'archives' },
    });
    expect(typeof asked.request_id).toBe('string');
    expect(String(asked.message)).toMatch(/Tell them to open Olympus on their computer/);
    expect(String(asked.message)).toMatch(/the file itself stays where it is/);
    expect((await f.remove(a.id)).request_id).toBe(asked.request_id);
    expect(watch.touching(a.path, b.path, f.exports, 'A.mbox', 'B.mbox')).toEqual([]);

    expect(f.runtime.state.list().map((record) => [record.label, record.status]).sort()).toEqual([['A.mbox', 'imported'], ['B.mbox', 'imported']]);
    expect(f.dashboard.view().requests).toEqual([expect.objectContaining({
      id: asked.request_id, kind: 'remove', name: 'A.mbox', origin: 'agent', status: 'pending', archiveId: a.id,
    })]);
    expect((await f.status()).requests).toEqual([expect.objectContaining({
      kind: 'remove', name: 'A.mbox', state: 'waiting_for_approval', note: expect.stringContaining('Remove or Decline'),
    })]);
    // An id that is not an imported archive records nothing.
    for (const id of ['6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60', 'nope']) {
      expect(await f.remove(id)).toMatchObject({ ok: false, code: 'unknown_archive' });
    }
    // The route answers the same for a body that is not even a string id.
    for (const body of [{ archive_id: 12 }, {}]) {
      const wire = await f.guarded(new Request(`${ORIGIN}/v1/archive-import/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      }));
      expect(await wire.json()).toMatchObject({ ok: false, code: 'unknown_archive' });
    }
    await expect(archiveImport.handler(f.ctx, { action: 'remove' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(f.dashboard.view().requests).toHaveLength(1);
  });

  test('approved by the person: that archive is removed and the other one is untouched; the files stay', async () => {
    const f = fixture();
    const a = await imported(f, 'A.mbox', [mail(0, { tag: 'a' }), mail(1, { tag: 'a' })]);
    const b = await imported(f, 'B.mbox', [mail(0, { tag: 'b' }), mail(1, { tag: 'b' }), mail(2, { tag: 'b' })]);
    const asked = await f.remove(a.id);
    const otherRequest = await f.start(join(f.exports, 'Later.mbox'));

    // A request to remove is not an import, and an import request is not a removal.
    expect(await f.dashboard.approve({ requestId: String(asked.request_id) })).toMatchObject({ ok: false, code: 'not_an_import' });
    expect(f.dashboard.approveRemoval(String(otherRequest.request_id))).toMatchObject({ ok: false, code: 'not_a_removal' });
    expect(f.runtime.state.get(a.id)!.status).toBe('imported');

    expect(f.dashboard.approveRemoval(String(asked.request_id))).toEqual({ ok: true });
    expect(f.runtime.state.get(a.id)!.status).toBe('removing');
    expect(f.runtime.state.get(b.id)!.status).toBe('imported');
    const lane = f.runtime.lane('email');
    let removal = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: a.id });
    for (let run = 0; run < 20 && removal.kind === 'progress'; run += 1) {
      removal = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: a.id });
    }
    expect(removal.kind).toBe('removed');
    const left = f.dashboard.view();
    expect(left.archives.map((entry) => [entry.name, entry.status, entry.items])).toEqual([['B.mbox', 'imported', 3]]);
    // The other request is still waiting, the answered one is gone, and both files are where they were.
    expect(left.requests.map((request) => request.id)).toEqual([String(otherRequest.request_id)]);
    expect(readFileSync(a.path, 'utf8')).toBe(mbox([mail(0, { tag: 'a' }), mail(1, { tag: 'a' })]));
    expect(readFileSync(b.path, 'utf8').length).toBeGreaterThan(0);
    // Asking about a removed archive is unknown; asking about one on its way out says so.
    expect(await f.remove(a.id)).toMatchObject({ ok: false, code: 'unknown_archive' });
  });

  test('declined by the person: nothing is removed, and the request is gone', async () => {
    const f = fixture();
    const a = await imported(f, 'A.mbox', [mail(0, { tag: 'a' })]);
    const asked = await f.remove(a.id);
    expect(f.dashboard.decline(String(asked.request_id))).toEqual({ ok: true });
    expect(f.dashboard.view().requests).toEqual([]);
    expect(f.dashboard.approveRemoval(String(asked.request_id))).toMatchObject({ ok: false, code: 'not_waiting' });
    expect(f.runtime.state.get(a.id)!.status).toBe('imported');
    expect((await f.status()).archives).toEqual([expect.objectContaining({ archive_id: a.id, status: 'imported', messages: 1 })]);
    // The agent may ask again, and gets a fresh request.
    expect((await f.remove(a.id)).request_id).not.toBe(asked.request_id);
  });

  test('a removal request for an archive that is already on its way out asks the person nothing and removes nothing else', async () => {
    const f = fixture();
    const a = await imported(f, 'A.mbox', [mail(0, { tag: 'a' })]);
    const b = await imported(f, 'B.mbox', [mail(0, { tag: 'b' })]);
    const asked = await f.remove(a.id);
    // The person removes A on the Archives row itself; the agent's request is now moot.
    expect(f.dashboard.remove(a.id)).toEqual({ ok: true });
    expect(f.dashboard.view().requests).toEqual([]);
    expect(f.dashboard.present().attention).toBeUndefined();
    expect(f.dashboard.approveRemoval(String(asked.request_id))).toMatchObject({ ok: false, code: 'not_waiting' });
    expect(await f.remove(a.id)).toMatchObject({ ok: true, status: 'removing', archive_id: a.id });
    expect(f.runtime.state.get(b.id)!.status).toBe('imported');
  });

  test('the person sees it under Needs you on the computer and in ChatGPT, with the way to Remove or Decline it', async () => {
    const f = fixture();
    const a = await imported(f, 'Old work mail.mbox', [mail(0, { tag: 'a' })]);
    const asked = await f.remove(a.id);
    const present: DashboardImportedArchives = f.dashboard.present();
    expect(present.attention).toEqual([{ kind: 'removal', id: String(asked.request_id), name: 'Old work mail.mbox' }]);

    const now = new Date('2026-10-23T12:00:00.000Z');
    const card = buildSourceDashboardViewModel({
      sourceIndexStatus: { kind: 'source_index_status', generated_at: now.toISOString(), corpora: [], policy: {} } as unknown as SourceIndexStatusResult,
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: { version: 1, handles: [] },
      apiKeyAvailability: {},
      importedArchives: present,
      now,
    });
    const model = buildChatGptDashboardViewModel(card, { now });
    const item = model.needsYou.find((entry) => entry.id === `archive-request:${asked.request_id}`)!;
    expect(item.sentence).toBe(A.needsYou.removal.replace('{name}', 'Old work mail.mbox'));
    expect(item.sentence).toBe('An agent asked to remove Old work mail.mbox');
    expect(item.fix).toMatchObject({ label: A.needsYou.review, href: 'https://olympusplugin.ai/open/archives/' });
    expect(model.sources.find((source) => source.id === 'archive.imports')!.status).toBe('Needs you');
    // On the computer's panel the request names what Remove deletes and what it leaves.
    expect(A.removeRequestNote).toBe('Removing deletes everything Olympus made from it. The file itself stays where it is.');
    expect(f.dashboard.view().requests[0]).toMatchObject({ kind: 'remove', archiveId: a.id, name: 'Old work mail.mbox' });
  });
});

describe('no path that holds only the worker bearer approves or removes anything', () => {
  /** This computer's own browser: same origin, a loopback socket peer, no bearer. */
  async function localSession(f: Fixture): Promise<Record<string, string>> {
    const request = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
    recordRequestPeer(request, '127.0.0.1');
    const mint = await f.guarded(request);
    expect(mint.status).toBe(200);
    return {
      Cookie: (mint.headers.get('Set-Cookie') ?? '').split(';')[0]!,
      'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token,
    };
  }
  const post = (f: Fixture, path: string, body: unknown, headers: Record<string, string>) => f.guarded(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  }));

  test('the agent routes only record: a start or a remove through the bearer leaves every archive and file as it was', async () => {
    const f = fixture();
    const a = await imported(f, 'A.mbox', [mail(0, { tag: 'a' })]);
    const before = readFileSync(f.runtime.state.path, 'utf8');
    const watch = watchFilesystem();
    const start = await f.start(join(f.exports, 'Pending.mbox'));
    const remove = await f.remove(a.id);
    expect([start.code, remove.code]).toEqual(['needs_approval', 'needs_approval']);
    expect(readFileSync(f.runtime.state.path, 'utf8')).toBe(before);
    expect(f.runtime.state.get(a.id)!.status).toBe('imported');
    expect(watch.touching('Pending.mbox', 'A.mbox')).toEqual([]);
    // No route under /v1/archive-import approves, declines or removes; each is answered as not found.
    for (const action of ['approve', 'decline', 'import', 'delete']) {
      const wire = await f.guarded(new Request(`${ORIGIN}/v1/archive-import/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ request_id: remove.request_id, archive_id: a.id, path: join(f.exports, 'Pending.mbox'), acknowledge: true }),
      }));
      expect([action, wire.status]).toEqual([action, 404]);
    }
    expect(f.dashboard.view().requests).toHaveLength(2);
    expect(f.runtime.state.list()).toHaveLength(1);
  });

  test('approving the removal: the bearer alone, with a session it minted, or with a forged grade header is refused; this computer\'s own session removes it', async () => {
    const f = fixture();
    const a = await imported(f, 'A.mbox', [mail(0, { tag: 'a' })]);
    const b = await imported(f, 'B.mbox', [mail(0, { tag: 'b' })]);
    const asked = await f.remove(a.id);
    const body = { request_id: asked.request_id, acknowledge: true };
    const route = '/dashboard/archive-import/remove';

    const bearer = { Authorization: `Bearer ${TOKEN}` };
    const bare = await post(f, route, body, bearer);
    expect(bare.status).toBe(403);
    expect(await bare.json()).toMatchObject({ error: { code: 'mac_dashboard_only' } });
    const minted = await f.guarded(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { ...bearer, Origin: ORIGIN } }));
    expect(minted.status).toBe(200);
    const bearerSession = {
      Cookie: minted.headers.get('Set-Cookie')!.split(';')[0]!,
      'X-Olympus-CSRF': ((await minted.json()) as { csrf_token: string }).csrf_token,
    };
    for (const headers of [
      { ...bearer, ...bearerSession },
      bearerSession,
      { ...bearer, 'X-Olympus-Control-Session-Grade': 'local' },
    ]) {
      expect((await post(f, route, body, headers)).status).toBe(403);
    }
    // The same for approving an import request and declining either kind.
    const importAsk = await f.start(join(f.exports, 'Pending.mbox'));
    for (const [path, payload] of [
      ['/dashboard/archive-import/approve', { request_id: importAsk.request_id }],
      ['/dashboard/archive-import/decline', { request_id: asked.request_id }],
      ['/dashboard/archive-import/remove', { archive_id: a.id, acknowledge: true }],
    ] as const) {
      expect([path, (await post(f, path, payload, bearer)).status]).toEqual([path, 403]);
      expect([path, (await post(f, path, payload, bearerSession)).status]).toEqual([path, 403]);
    }
    expect(f.runtime.state.list().map((record) => [record.label, record.status]).sort()).toEqual([['A.mbox', 'imported'], ['B.mbox', 'imported']]);
    expect(f.dashboard.view().requests.map((request) => request.id).sort()).toEqual([String(asked.request_id), String(importAsk.request_id)].sort());

    // This computer's own session is the person: the removal runs, for that archive only.
    const local = await localSession(f);
    const unconfirmed = await post(f, route, { request_id: asked.request_id }, local);
    expect(unconfirmed.status).toBe(400);
    expect(f.runtime.state.get(a.id)!.status).toBe('imported');
    const approved = await post(f, route, body, local);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ ok: true });
    expect(f.runtime.state.get(a.id)!.status).toBe('removing');
    expect(f.runtime.state.get(b.id)!.status).toBe('imported');
    // Exactly one of archive_id and request_id.
    expect((await post(f, route, { acknowledge: true }, local)).status).toBe(400);
    expect((await post(f, route, { archive_id: b.id, request_id: asked.request_id, acknowledge: true }, local)).status).toBe(400);
    expect(f.runtime.state.get(b.id)!.status).toBe('imported');
  });

  test('the panel\'s tool path refuses the bearer too: no archive tool reaches the route without this computer\'s own session', async () => {
    const f = fixture();
    const a = await imported(f, 'A.mbox', [mail(0, { tag: 'a' })]);
    const asked = await f.remove(a.id);
    const importAsk = await f.start(join(f.exports, 'Pending.mbox'));
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    const minted = await f.guarded(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { ...bearer, Origin: ORIGIN } }));
    const bearerSession = {
      Cookie: minted.headers.get('Set-Cookie')!.split(';')[0]!,
      'X-Olympus-CSRF': ((await minted.json()) as { csrf_token: string }).csrf_token,
    };
    const call = async (headers: Record<string, string>, name: string, args: Record<string, unknown>) => {
      const response = await post(f, '/dashboard/tools/call', { name, arguments: args }, headers);
      return { status: response.status, body: await response.json() as { isError?: boolean; structuredContent?: Record<string, unknown> } };
    };
    const attempts: Array<[string, Record<string, unknown>]> = [
      [ARCHIVE_REMOVE_TOOL_NAME, { request_id: asked.request_id }],
      [ARCHIVE_REMOVE_TOOL_NAME, { archive_id: a.id }],
      [ARCHIVE_APPROVE_TOOL_NAME, { request_id: importAsk.request_id }],
      [ARCHIVE_DECLINE_TOOL_NAME, { request_id: asked.request_id }],
    ];
    for (const headers of [bearer, { ...bearer, ...bearerSession }, bearerSession]) {
      for (const [name, args] of attempts) {
        const answer = await call(headers, name, args);
        expect([name, answer.body.isError, answer.body.structuredContent]).toEqual([name, true, { error: 'mac_dashboard_only' }]);
      }
    }
    expect(f.runtime.state.get(a.id)!.status).toBe('imported');
    expect(f.dashboard.view().requests.map((request) => request.id).sort()).toEqual([String(asked.request_id), String(importAsk.request_id)].sort());

    // This computer's own session is the person: the same tool call removes that archive.
    const local = await localSession(f);
    const done = await call(local, ARCHIVE_REMOVE_TOOL_NAME, { request_id: asked.request_id });
    expect(done.body.isError).toBeUndefined();
    expect(done.body.structuredContent).toEqual({ status: 'removing' });
    expect(f.runtime.state.get(a.id)!.status).toBe('removing');
    // And a call that names both an archive and a request is refused as malformed.
    const both = await call(local, ARCHIVE_REMOVE_TOOL_NAME, { request_id: importAsk.request_id, archive_id: a.id });
    expect(both.body.isError).toBe(true);
  });
});

describe('where it is offered', () => {
  test('the native, MCP and CLI lists carry it; Hermes, remote MCP and the relay\'s lists do not', () => {
    expect(V0_4_PUBLIC_NATIVE_TOOLS).toContain('archive_import');
    expect(V0_4_PUBLIC_MCP_TOOLS).toContain('archive_import');
    expect(V0_4_PUBLIC_CLI_OPERATIONS).toContain('archive_import');
    expect(V0_4_PUBLIC_CLI_COMMANDS).toContain('archive');
    expect(V0_4_HERMES_MCP_TOOLS).not.toContain('archive_import' as never);
    expect(V0_4_PUBLIC_REMOTE_MCP_TOOLS).not.toContain('archive_import' as never);

    const config = defaultConfig();
    const named = (surface: OperationSurface) =>
      exposedOperations(operations, { config, surface }).map((operation) => operation.name);
    for (const surface of ['native', 'mcp', 'cli'] as const) expect(named(surface)).toContain('archive_import');
    expect(named('remote')).not.toContain('archive_import');
    // With the source index off there is no engine for it to ask.
    const off = defaultConfig();
    off.sourceIndex.enabled = false;
    expect(exposedOperations(operations, { config: off, surface: 'native' }).map((operation) => operation.name)).not.toContain('archive_import');

    // The relay's generated tool lists and the directory listing OpenAI reviews never name it.
    for (const file of ['chatgpt-tools.json', 'remote-tools.json', 'chatgpt-dashboard.json']) {
      expect([file, readFileSync(join(import.meta.dir, '..', 'connect-relay', 'server', 'generated', file), 'utf8').includes('archive_import')]).toEqual([file, false]);
    }
    expect(readFileSync(join(import.meta.dir, '..', 'connect-relay', 'server', 'directory', 'approved.ts'), 'utf8')).not.toContain('archive_import');
  });

  test('the description tells an agent when to offer it, that it only asks, and to leave the file alone', () => {
    expect(archiveImport.mutating).toBe(true);
    expect(archiveImport.description).toMatch(/Offer it when the user mentions such an export/);
    expect(archiveImport.description).toMatch(/You can only ask/);
    expect(archiveImport.description).toMatch(/Never open, read or copy the file yourself/);
    expect(archiveImport.description).toMatch(/needs_approval/);
    expect(archiveImport.description).toMatch(/never message text|no message text/);
  });
});
