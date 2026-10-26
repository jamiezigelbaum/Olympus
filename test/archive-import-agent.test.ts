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
import { parseArgs } from '../src/cli.ts';
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
import { createArchiveImportAgent } from '../src/workers/archive-import/agent.ts';
import { createArchiveImportDashboard, type ArchivePrivateModelState } from '../src/workers/archive-import/dashboard.ts';
import { runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { ARCHIVE_IMPORT_PENDING_REQUESTS_MAX, ArchiveImportRequestStore, archiveImportRequestsPath } from '../src/workers/archive-import/requests.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { pullArchiveImport } from '../src/workers/archive-import/sync.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';
import { createDashboardPanelTools } from '../src/workers/email-source/dashboard-panel-tools.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';
import { MacPermissions } from '../src/workers/local-files/mac-permissions.ts';
import { createArchivePathResolver } from '../src/workers/local-files/scope-browser.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { buildSourceDashboardViewModel, type DashboardImportedArchives } from '../src/workers/source-dashboard.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { approveStaged, stageUpload } from './support/stage-upload.ts';

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
  const resolver = createArchivePathResolver({ volumes, home, permissions });
  let model: ArchivePrivateModelState = options.model ?? 'ready';
  const dashboard = createArchiveImportDashboard({
    runtime,
    resolver,
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

/** The agent names the file, the person's approval at the dashboard follows (read in place), then the import runs to the end. */
async function imported(f: Fixture, name: string, messages: readonly string[]): Promise<{ id: string; path: string }> {
  const path = f.write(name, mbox(messages));
  const asked = await f.start(path);
  if (asked.ok !== false || typeof asked.request_id !== 'string') throw new Error('expected a request');
  const started = await f.dashboard.approve({ requestId: asked.request_id });
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

  test('a path that matches an earlier record is reported as that record, in its state, and still asks: the path is not proof of the same export', async () => {
    const f = fixture();
    const { id, path } = await imported(f, 'Takeout.mbox', [mail(0), mail(1)]);
    const watch = watchFilesystem();
    const asked = await f.start(path);
    expect(asked).toMatchObject({
      ok: false,
      code: 'needs_approval',
      existing_record: { archive_id: id, name: 'Takeout.mbox', state: 'imported' },
    });
    // Never "already imported": the agent is not told the file is a duplicate, because nothing has compared it.
    expect(JSON.stringify(asked)).not.toMatch(/already[ _]imported/i);
    expect(String(asked.message)).toContain('earlier import from this same path: Takeout.mbox');
    expect(String(asked.message)).toContain('may have been replaced');
    expect(String(asked.message)).toContain('recorded a request for the file as it is now');
    expect(String(asked.message)).toContain('compares it with what it already holds');
    // A request waits for the person, and nothing on the disk was consulted to say so.
    expect(f.dashboard.view().requests).toEqual([expect.objectContaining({ id: asked.request_id, status: 'pending', origin: 'agent' })]);
    expect(watch.touching(path, f.exports, 'Takeout.mbox')).toEqual([]);
    expect(f.runtime.state.list()).toHaveLength(1);

    // The same request again is the same request, not a second line for the person.
    expect((await f.start(path)).request_id).toBe(asked.request_id);
    expect(f.dashboard.view().requests).toHaveLength(1);
    // A different file is a new request, with no earlier record to report.
    const other = await f.start(join(f.exports, 'Other.mbox'));
    expect(other).toMatchObject({ code: 'needs_approval' });
    expect(other.existing_record).toBeUndefined();
    expect(f.dashboard.view().requests).toHaveLength(2);
  });

  test('the same file approved again is found to be the same export by the approval, which reads it; one that replaced it is imported', async () => {
    const f = fixture();
    const first = await imported(f, 'Takeout.mbox', [mail(0), mail(1)]);

    // Unchanged: the dashboard's own comparison says it is already imported, and nothing is imported twice.
    const same = await f.start(first.path);
    expect(same).toMatchObject({ code: 'needs_approval', existing_record: { archive_id: first.id } });
    expect(await f.dashboard.approve({ requestId: String(same.request_id) }))
      .toMatchObject({ ok: true, status: 'already_imported', archive_id: first.id });
    expect(f.runtime.state.list()).toHaveLength(1);
    expect(f.dashboard.view().requests).toEqual([]);

    // The person replaces Takeout.mbox with a newer export. The old code answered "already imported" here
    // and recorded nothing, so the newer export could never be approved.
    writeFileSync(first.path, mbox([mail(0), mail(1), mail(2, { tag: 'newer' }), mail(3, { tag: 'newer' })]));
    const newer = await f.start(first.path);
    expect(newer).toMatchObject({ ok: false, code: 'needs_approval', existing_record: { archive_id: first.id, state: 'imported' } });
    expect(f.dashboard.view().requests).toEqual([expect.objectContaining({ id: newer.request_id, status: 'pending' })]);
    const approved = await f.dashboard.approve({ requestId: String(newer.request_id) });
    expect(approved).toMatchObject({ ok: true, status: 'started' });
    expect(f.runtime.state.list()).toHaveLength(2);
    expect(f.runtime.state.get(first.id)!.status).toBe('imported');
  });

  test('an import that has not read anything, or stopped, is reported in its own state, not as already imported', async () => {
    const f = fixture();
    const path = f.write('Takeout.mbox', mbox([mail(0)]));
    const asked = await f.start(path);
    if (asked.ok !== false || typeof asked.request_id !== 'string') throw new Error('expected a request');
    const started = await f.dashboard.approve({ requestId: asked.request_id });
    if (!started.ok || started.status !== 'started') throw new Error('expected a start');
    // Approved a moment ago: importing, nothing read yet.
    const importing = await f.start(path);
    expect(importing).toMatchObject({
      ok: false, code: 'needs_approval', existing_record: { archive_id: started.archive_id, name: 'Takeout.mbox', state: 'importing' },
    });
    expect(String(importing.message)).toContain('Olympus is importing Takeout.mbox from this same path now.');
    expect(JSON.stringify(importing)).not.toMatch(/already[ _]imported/i);

    // It stopped before reading a message: the file went missing under it.
    f.runtime.state.update(started.archive_id, (record) => {
      record.status = 'stopped';
      record.stop = { code: 'file_missing', message: 'gone', at: '2026-10-23T10:00:00.000Z' };
    });
    const stopped = await f.start(path);
    expect(stopped).toMatchObject({ code: 'needs_approval', existing_record: { archive_id: started.archive_id, state: 'stopped' } });
    expect(String(stopped.message)).toContain('stopped before it finished');
    expect(stopped.request_id).toBe(importing.request_id);
    expect(f.dashboard.view().requests).toHaveLength(1);
  });
});

describe('a path cannot disguise what the person approves', () => {
  /** Name, and how a person must be shown it: every character that hides or reorders, written out. */
  const HOSTILE: Array<[string, string]> = [
    ['Inbox\u200B.mbox', 'Inbox\u27E8U+200B\u27E9.mbox'],
    ['Takeout\u202Egpj.mbox', 'Takeout\u27E8U+202E\u27E9gpj.mbox'],
    ['Inbox\u2066.mbox', 'Inbox\u27E8U+2066\u27E9.mbox'],
    ['\uFEFFInbox.mbox', '\u27E8U+FEFF\u27E9Inbox.mbox'],
    ['Inbox\u00A0.mbox', 'Inbox\u27E8U+00A0\u27E9.mbox'],
    ['Inbox\u27E8U+200B\u27E9.mbox', 'Inbox\u27E8U+27E8\u27E9U+200B\u27E8U+27E9\u27E9.mbox'],
  ];
  /** Any control, format, separator or space-like character left in the text, except the isolates the display adds on purpose. */
  const stray = (text: string): string[] =>
    (text.replace(/[\u2068\u2069]/g, '').match(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu) ?? []).filter((char) => char !== ' ');

  /** The Needs you sentences both surfaces show, from the engine's own list. */
  function sentences(f: Fixture): string[] {
    const now = new Date('2026-10-23T12:00:00.000Z');
    const card = buildSourceDashboardViewModel({
      sourceIndexStatus: { kind: 'source_index_status', generated_at: now.toISOString(), corpora: [], policy: {} } as unknown as SourceIndexStatusResult,
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: { version: 1, handles: [] },
      apiKeyAvailability: {},
      importedArchives: f.dashboard.present(),
      now,
    });
    return buildChatGptDashboardViewModel(card, { now }).needsYou.map((item) => item.sentence);
  }

  test('an invisible or direction-changing character is written out in the message, the list, the line under Needs you and the full path', async () => {
    for (const [name, shown] of HOSTILE) {
      const f = fixture();
      const path = join(f.exports, name);
      const asked = await f.start(path);
      expect(asked).toMatchObject({ code: 'needs_approval' });
      const view = f.dashboard.view();
      const status = await f.status();
      const line = sentences(f).find((sentence) => sentence.startsWith('An agent asked to import'))!;

      // The agent's words, the engine's list, the agent's own status and the Needs you line all name it visibly.
      expect(String(asked.message)).toContain(shown);
      expect(view.requests[0]!.name).toBe(`\u2068${shown}\u2069`);
      expect(view.requests[0]!.path).toBe(`\u2068~/Mail exports/${shown}\u2069`);
      expect(view.requests[0]!.where).toBe('~/Mail exports');
      expect((status.requests as Array<{ name: string }>)[0]!.name).toBe(`\u2068${shown}\u2069`);
      expect(line).toBe(`An agent asked to import \u2068${shown}\u2069`);
      for (const text of [String(asked.message), JSON.stringify(view), JSON.stringify(status), line]) {
        expect([name, stray(text)]).toEqual([name, []]);
      }
      // Only what is shown is written out: the request keeps the path exactly as asked.
      expect(new ArchiveImportRequestStore({ path: f.requestsPath }).list()[0]!.path).toBe(path);
    }
  });

  test('an ordinary name is shown exactly as it is, and right-to-left text is isolated from the words around it', async () => {
    const f = fixture();
    const plain = await f.start(join(f.exports, 'Takeout 2.mbox'));
    expect(String(plain.message)).toContain('request for Takeout 2.mbox.');
    expect(f.dashboard.view().requests[0]).toMatchObject({ name: 'Takeout 2.mbox', where: '~/Mail exports', path: '~/Mail exports/Takeout 2.mbox' });
    expect(sentences(f)).toContain('An agent asked to import Takeout 2.mbox');

    await f.start(join(f.exports, '\u05D3\u05D5\u05D0\u05E8.mbox'));
    const hebrew = f.dashboard.view().requests.find((entry) => entry.name.includes('\u05D3'))!;
    expect(hebrew.name).toBe('\u2068\u05D3\u05D5\u05D0\u05E8.mbox\u2069');
    expect(hebrew.path).toBe('\u2068~/Mail exports/\u05D3\u05D5\u05D0\u05E8.mbox\u2069');
  });

  test('approving a request opens the path as asked, not as shown: the file with the hidden character, not its look-alike', async () => {
    const f = fixture();
    const lookAlike = f.write('Inbox.mbox', mbox([mail(0, { tag: 'plain' })]));
    const hidden = f.write('Inbox\u200B.mbox', mbox([mail(0, { tag: 'hidden' }), mail(1, { tag: 'hidden' })]));
    const asked = await f.start(hidden);
    expect(String(asked.message)).toContain('Inbox\u27E8U+200B\u27E9.mbox');

    const started = await f.dashboard.approve({ requestId: String(asked.request_id) });
    expect(started).toMatchObject({ ok: true, status: 'started', name: '\u2068Inbox\u27E8U+200B\u27E9.mbox\u2069' });
    const records = f.runtime.state.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.chosen_rel_path).toBe('Inbox\u200B.mbox');
    expect(records[0]!.files.map((file) => file.rel_path)).toEqual(['Inbox\u200B.mbox']);
    expect(readFileSync(lookAlike, 'utf8')).toBe(mbox([mail(0, { tag: 'plain' })]));
    // The archive keeps its real name, and shows it written out.
    expect(f.dashboard.view().archives[0]!.name).toBe('\u2068Inbox\u27E8U+200B\u27E9.mbox\u2069');
  });

  test('a request to remove an archive names it visibly too, with the path it was imported from', async () => {
    const f = fixture();
    const a = await imported(f, 'Old\u202Email.mbox', [mail(0, { tag: 'a' })]);
    const asked = await f.remove(a.id);
    const shown = 'Old\u27E8U+202E\u27E9mail.mbox';
    expect(asked).toMatchObject({ code: 'needs_approval', name: `\u2068${shown}\u2069` });
    expect(String(asked.message)).toContain(shown);
    expect(f.dashboard.view().requests[0]).toMatchObject({ kind: 'remove', name: `\u2068${shown}\u2069`, path: `\u2068~/Mail exports/${shown}\u2069` });
    const line = sentences(f).find((sentence) => sentence.startsWith('An agent asked to remove'))!;
    expect(line).toBe(`An agent asked to remove \u2068${shown}\u2069`);
    for (const text of [String(asked.message), JSON.stringify(f.dashboard.view()), JSON.stringify(await f.status()), line]) {
      expect(stray(text)).toEqual([]);
    }
    // Removing it is still decided by the archive id, not by how its name reads.
    expect(f.dashboard.approveRemoval(String(asked.request_id))).toEqual({ ok: true });
    expect(f.runtime.state.get(a.id)!.status).toBe('removing');
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
      not_imported: [],
      how_read: [],
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

  test('an archive whose messages cannot be counted has no numbers, and imports that cannot run are said so', async () => {
    const f = fixture();
    const entry = {
      id: '0b9e4c52-7a1d-4d3e-9f0a-3c1b2a4d5e6f', name: 'Takeout.mbox', format: 'Mail (mbox)', where: '~/Mail exports', status: 'importing' as const,
      items: 0, judged: 0, held: 0, percent: 40, startedAt: '2026-10-23T10:00:00.000Z', gaps: [], skipped: [], countsUnavailable: true as const,
    };
    const agent = createArchiveImportAgent({
      state: f.runtime.state,
      requests: new ArchiveImportRequestStore({ path: f.requestsPath }),
      view: () => ({ sourceId: 'archive.imports', archives: [entry], requests: [], privateModel: 'off', notRunning: 'disabled' }),
    });
    const status = agent.status();
    if (!status.ok) throw new Error('expected a list');
    const [archive] = status.archives;
    expect(archive).toMatchObject({ archive_id: entry.id, status: 'importing', progress_percent: 40, counts_unavailable: true });
    // Not zero: unknown. And no private-model note about messages nobody could count.
    for (const key of ['messages', 'judged', 'waiting_for_private_model']) expect(archive).not.toHaveProperty(key);
    expect(archive!.summary).toContain('40% read');
    expect(archive!.summary).toContain("can't count what this archive holds");
    expect(status).not.toHaveProperty('private_model_note');
    expect(status.not_running).toEqual({
      setting: 'disabled',
      message: expect.stringContaining("Background syncing is turned off in Olympus's settings"),
    });
  });

  test('an archive says what its items are by its family: messages for mail, notes for notes, items when unknown; an empty import is said as empty', async () => {
    const f = fixture();
    const base = {
      id: '0b9e4c52-7a1d-4d3e-9f0a-3c1b2a4d5e6f', name: 'Export', format: 'Some export', where: '~/Exports', status: 'imported' as const,
      items: 12, judged: 12, held: 0, startedAt: '2026-10-23T10:00:00.000Z', importedAt: '2026-10-23T11:00:00.000Z', gaps: [], skipped: [],
    };
    const entries = [
      { ...base, id: 'a-mail', family: 'email' },
      { ...base, id: 'b-notes', family: 'note' },
      { ...base, id: 'c-chat', family: 'chat', items: 1 },
      { ...base, id: 'd-unknown' },
      { ...base, id: 'e-empty-notes', family: 'note', items: 0, judged: 0, held: 0 },
      // Found but all left out or not read: nothing imported is not an empty archive.
      { ...base, id: 'f-nothing-mail', family: 'email', items: 0, judged: 0, held: 0, skipped: [{ kind: 'spam_or_trash', count: 3 }], gaps: [{ kind: 'message_too_large', count: 1 }] },
      { ...base, id: 'g-nothing-notes', family: 'note', items: 0, judged: 0, held: 0, gaps: [{ kind: 'file_damaged', count: 2, file: 'notes.json' }] },
      // Reasons of a count of nothing do not count as reasons.
      { ...base, id: 'i-how-read', family: 'chat', gaps: [{ kind: 'media_not_imported', count: 1870 }, { kind: 'time_zone_assumed', count: 1 }, { kind: 'something_new', count: 4 }], skipped: [{ kind: 'system_message', count: 318 }, { kind: 'message_empty', count: 6 }] },
      { ...base, id: 'h-zero-reasons', family: 'chat', items: 0, judged: 0, held: 0, gaps: [{ kind: 'message_unreadable', count: 0 }] },
    ];
    const agent = createArchiveImportAgent({
      state: f.runtime.state,
      requests: new ArchiveImportRequestStore({ path: f.requestsPath }),
      view: () => ({ sourceId: 'archive.imports', archives: entries, requests: [], privateModel: 'ready' }),
    });
    const status = agent.status();
    if (!status.ok) throw new Error('expected a list');
    // None of these is an index that cannot be read (checked first: a matcher can stand in for the value it matched).
    for (const archive of status.archives) expect(archive.summary).not.toContain("can't count");
    const byId = new Map(status.archives.map((archive) => [archive.archive_id, archive]));
    // (before the matchers below, which can stand in for the values they matched.) A chat export is a snapshot, and an agent is told so; a mail or notes archive is not.
    expect(byId.get('c-chat')!.summary).toContain('Snapshot, not updated.');
    expect(byId.get('a-mail')!.summary).not.toContain('Snapshot');
    expect(byId.get('b-notes')!.summary).not.toContain('Snapshot');
    expect(byId.get('a-mail')).toMatchObject({ family: 'email', items: 12, messages: 12, summary: expect.stringContaining('12 messages') });
    expect(byId.get('b-notes')).toMatchObject({ family: 'note', items: 12, summary: expect.stringContaining('12 notes') });
    expect(byId.get('b-notes')).not.toHaveProperty('messages');
    expect(byId.get('c-chat')).toMatchObject({ family: 'chat', items: 1, messages: 1, summary: expect.stringContaining('1 message') });
    expect(byId.get('d-unknown')).toMatchObject({ family: 'other', items: 12, summary: expect.stringContaining('12 items') });
    expect(byId.get('d-unknown')).not.toHaveProperty('messages');
    // A finished import that found nothing reads as that, not as a count of nothing or an index that cannot be read.
    const empty = byId.get('e-empty-notes')!;
    expect(empty.summary).toBe('Imported: no notes found in this archive.');
    expect(empty).not.toHaveProperty('counts_unavailable');
    // Nothing imported although messages were found: said so, with the reasons, never as an empty archive.
    const nothing = byId.get('f-nothing-mail')!;
    expect(nothing.summary).toBe('No messages imported. 1 message too large to read; 3 messages in Spam or Trash left out.');
    expect(nothing.summary).not.toContain('found in this archive');
    // Spam and Trash left out are mail Olympus does not have: under not_imported with the rest, whichever way the engine classed them.
    expect(nothing.not_imported.map((line) => line.line)).toEqual(['1 message too large to read', '3 messages in Spam or Trash left out']);
    expect(nothing.how_read).toEqual([]);
    // How it was read: assumptions and deliberate leave-outs, apart from what was not imported; a kind nobody knows is not_imported.
    const read = byId.get('i-how-read')!;
    expect(read.how_read.map((line) => [line.kind, line.line])).toEqual([
      ['time_zone_assumed', "The times have no time zone, so Olympus read them in this computer's time zone"],
      ['system_message', '318 notices from WhatsApp itself (such as people joining) left out'],
      ['message_empty', '6 messages with no text left out'],
    ]);
    expect(read.not_imported.map((line) => [line.kind, line.line])).toEqual([
      ['media_not_imported', '1870 pictures, recordings or other files the archive refers to were not imported'],
      ['something_new', '4 items not read fully'],
    ]);
    expect(byId.get('g-nothing-notes')!.summary).toBe('No notes imported. notes.json: 2 files in the archive look damaged, so what was read from them may be wrong.');
    expect(byId.get('h-zero-reasons')!.summary).toBe('Imported: no messages found in this archive.');
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

  test('the CLI reads start, status and remove with their flags', () => {
    expect(archiveImport.cliHints).toEqual({ name: 'archive', positional: ['action'] });
    expect(parseArgs(archiveImport, ['start', '--path', '/Users/someone/Takeout.mbox'])).toEqual({ action: 'start', path: '/Users/someone/Takeout.mbox' });
    expect(parseArgs(archiveImport, ['status'])).toEqual({ action: 'status' });
    expect(parseArgs(archiveImport, ['remove', '--archive-id', '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60'])).toEqual({ action: 'remove', archive_id: '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60' });
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
