import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ENGINE_BRIEF_SCHEMA,
  engineBriefFromViewModel,
  engineBriefReport,
  parseEngineBrief,
  type EngineBriefViewModel,
} from '../src/core/engine-brief.ts';
import { runEngineCommand } from '../src/core/engine-cli.ts';
import { ENGINE_LABEL, enginePaths, engineServicePaths, type EngineExec } from '../src/core/engine-service.ts';
import { bindWorkerSocket, prepareWorkerSocket } from '../src/core/worker-transport.ts';
import { withRequestPeer } from '../src/core/request-peer.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { withEngineBriefRoute } from '../src/workers/engine-brief-route.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A dashboard item as the view model carries it: sentence plus a fix full of things the brief must drop. */
function item(id: string, sentence: string) {
  return {
    id,
    sentence,
    fix: {
      label: 'Reconnect',
      tool: 'olympus_connect_source',
      args: { source_id: 'dropbox.files', note: 'args-must-not-leak' },
      href: 'https://olympusplugin.ai/open/connect/dropbox/?secret=href-must-not-leak',
      disabledReason: 'disabled-reason-must-not-leak',
    },
  };
}

function view(overrides: Partial<EngineBriefViewModel> = {}): EngineBriefViewModel {
  return { needsYou: [], ...overrides } as EngineBriefViewModel;
}

describe('engine brief: the worker side keeps only words and numbers', () => {
  test('whitelists sentence and the progress numbers; no fix, href, args, id or tool name survives', () => {
    const brief = engineBriefFromViewModel(view({
      blocker: item('blocker:one', 'Olympus is paused') as never,
      needsYou: [
        item('source:dropbox.files', 'Dropbox — signed out'),
        item('model:embedding', "indexing has stopped"),
      ],
      progress: {
        unit: 'files',
        phase: 'initial',
        percent: 42,
        itemsLeft: 1830,
        etaSeconds: 2400,
        stalled: false,
        details: [{ stage: 'indexing', unit: 'files', done: 1300, total: 3130 }],
      },
    }));
    expect(brief).toEqual({
      schema: 'olympus.engine.brief.v1',
      progress: { unit: 'files', phase: 'initial', percent: 42, itemsLeft: 1830, etaSeconds: 2400, stalled: false },
      blocker: 'Olympus is paused',
      needsYou: { count: 2, sentences: ['Dropbox — signed out', 'indexing has stopped'] },
    });
    const text = JSON.stringify(brief);
    for (const leaked of ['args-must-not-leak', 'href-must-not-leak', 'disabled-reason-must-not-leak', 'olympus_connect_source', 'source:dropbox', 'model:embedding', 'details', 'Reconnect']) {
      expect(text).not.toContain(leaked);
    }
  });

  test('etaSeconds is omitted when absent, and no progress and no blocker are null', () => {
    const withoutEta = engineBriefFromViewModel(view({
      progress: { unit: 'messages', phase: 'refresh', percent: 99.5, itemsLeft: 3, stalled: true, details: [] },
    }));
    expect(withoutEta.progress).toEqual({ unit: 'messages', phase: 'refresh', percent: 99.5, itemsLeft: 3, stalled: true });
    expect('etaSeconds' in withoutEta.progress!).toBe(false);
    expect(engineBriefFromViewModel(view())).toEqual({
      schema: 'olympus.engine.brief.v1',
      progress: null,
      blocker: null,
      needsYou: { count: 0, sentences: [] },
    });
  });

  test('sentences are capped at five, in order, while count stays the true total', () => {
    const sentences = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    const brief = engineBriefFromViewModel(view({ needsYou: sentences.map((sentence, index) => item(`id:${index}`, sentence)) }));
    expect(brief.needsYou).toEqual({ count: 7, sentences: ['one', 'two', 'three', 'four', 'five'] });
  });

  test('the CLI re-reads a worker answer through the same whitelist and refuses anything else', () => {
    const parsed = parseEngineBrief({
      schema: ENGINE_BRIEF_SCHEMA,
      progress: { unit: 'items', phase: 'initial', percent: 10, itemsLeft: 9, stalled: false, token: 'extra-must-not-pass' },
      blocker: null,
      needsYou: { count: 1, sentences: ['a', 7, 'b'], href: 'extra-must-not-pass' },
      extra: 'extra-must-not-pass',
    });
    expect(parsed).toEqual({
      schema: ENGINE_BRIEF_SCHEMA,
      progress: { unit: 'items', phase: 'initial', percent: 10, itemsLeft: 9, stalled: false },
      blocker: null,
      needsYou: { count: 2, sentences: ['a', 'b'] },
    });
    expect(parseEngineBrief({ schema: 'something.else' })).toBeUndefined();
    expect(parseEngineBrief({ schema: ENGINE_BRIEF_SCHEMA, progress: { unit: 'bytes' }, blocker: null, needsYou: { count: 0, sentences: [] } })).toBeUndefined();
    expect(parseEngineBrief('nope')).toBeUndefined();
  });
});

describe('GET /v1/engine/brief requires the worker bearer', () => {
  const bearer = 'test-bearer-for-brief-route';
  const url = 'http://127.0.0.1:8010/v1/engine/brief';
  function worker(viewFn: () => Promise<EngineBriefViewModel>) {
    let reachedWorker = 0;
    const inner = withEngineBriefRoute(async () => { reachedWorker += 1; return new Response('worker', { status: 200 }); }, { view: viewFn });
    return { fetch: withWorkerBearerAuth(inner, { authToken: bearer }), reachedWorker: () => reachedWorker };
  }
  const fixture = async () => view({ needsYou: [item('x', 'Dropbox — signed out')] });

  test('no bearer, or a wrong one, is refused and never reaches the view', async () => {
    let built = 0;
    const { fetch: handler } = worker(async () => { built += 1; return fixture(); });
    expect((await handler(new Request(url))).status).toBe(401);
    expect((await handler(new Request(url, { headers: { Authorization: 'Bearer wrong' } }))).status).toBe(401);
    expect(built).toBe(0);
  });

  test('the bearer gets the brief with no-store caching', async () => {
    const { fetch: handler } = worker(fixture);
    const response = await handler(new Request(url, { headers: { Authorization: `Bearer ${bearer}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schema: 'olympus.engine.brief.v1',
      progress: null,
      blocker: null,
      needsYou: { count: 1, sentences: ['Dropbox — signed out'] },
    });
  });

  test('other methods get 405, other paths fall through, and a view that fails is a fixed 503', async () => {
    const ok = worker(fixture);
    const auth = { Authorization: `Bearer ${bearer}` };
    expect((await ok.fetch(new Request(url, { method: 'POST', headers: auth }))).status).toBe(405);
    const other = await ok.fetch(new Request('http://127.0.0.1:8010/v1/other', { headers: auth }));
    expect(await other.text()).toBe('worker');
    const failing = worker(async () => { throw new Error('/Users/someone/private/file.pdf exploded'); });
    const response = await failing.fetch(new Request(url, { headers: auth }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });
});

describe('olympus engine status --brief', () => {
  const token = 'test-bearer-for-brief-cli';

  function setup(options: { installed?: boolean; config?: Record<string, unknown> } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'olympus-brief-'));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const paths = enginePaths(home);
    if (options.installed !== false) {
      mkdirSync(dirname(paths.plistPath), { recursive: true });
      writeFileSync(paths.plistPath, '<plist/>');
    }
    return { home, paths };
  }

  /** launchctl print for the engine label: running pid 4242, loaded but waiting, or not loaded. */
  function launchctl(state: 'running' | 'waiting' | 'absent'): EngineExec {
    return (_command, args) => {
      expect(args[0]).toBe('print');
      if (state === 'absent') return { status: 113, stdout: '', stderr: `Could not find service "${ENGINE_LABEL}" in domain for user gui: 501\n` };
      return { status: 0, stdout: `${ENGINE_LABEL} = {\n\tstate = ${state}\n\tpid = 4242\n\tlast exit code = 0\n}\n`, stderr: '' };
    };
  }

  const brief = {
    schema: 'olympus.engine.brief.v1' as const,
    progress: { unit: 'files' as const, phase: 'initial' as const, percent: 42, itemsLeft: 1830, etaSeconds: 2400, stalled: false },
    blocker: null,
    needsYou: { count: 2, sentences: ['Dropbox — signed out', 'Gmail — finish signing in'] },
  };

  function workerFetch(handlers: { health?: () => Response; brief?: (init: RequestInit | undefined) => Response | Promise<Response> }, seen: Array<{ url: string; authorization: string | null }> = []): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
      if (url.endsWith('/health')) {
        if (!handlers.health) throw new Error('connect ECONNREFUSED');
        return handlers.health();
      }
      if (url.endsWith('/engine/brief')) {
        if (!handlers.brief) throw new Error('connect ECONNREFUSED');
        return handlers.brief(init);
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
  }

  const common = (home: string) => ({ homeDir: home, platform: 'darwin', env: { HOME: home, OLYMPUS_WORKER_AUTH_TOKEN: token } });

  test('not installed and stopped read the agent only and never call the worker', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('{}'); }) as unknown as typeof fetch;
    const missing = setup({ installed: false });
    expect(await engineBriefReport({ ...common(missing.home), exec: launchctl('absent'), fetchImpl })).toEqual({
      schema: ENGINE_BRIEF_SCHEMA, state: 'not_installed', progress: null, blocker: null, needsYou: null, detail: 'Olympus is not installed on this computer.',
    });
    const installed = setup();
    for (const state of ['absent', 'waiting'] as const) {
      expect(await engineBriefReport({ ...common(installed.home), exec: launchctl(state), fetchImpl })).toEqual({
        schema: ENGINE_BRIEF_SCHEMA, state: 'stopped', progress: null, blocker: null, needsYou: null, detail: 'Olympus is stopped.',
      });
    }
    expect(calls).toEqual([]);
  });

  test('running with an answering worker returns the brief, sends the bearer, and never prints it', async () => {
    const { home } = setup();
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const report = await engineBriefReport({
      ...common(home),
      exec: launchctl('running'),
      fetchImpl: workerFetch({
        health: () => Response.json({ ok: true }),
        brief: () => Response.json({ ...brief, fix: { href: 'extra-must-not-print' }, token: 'extra-must-not-print' }),
      }, seen),
    });
    expect(report).toEqual({
      schema: ENGINE_BRIEF_SCHEMA,
      state: 'running',
      progress: brief.progress,
      blocker: null,
      needsYou: brief.needsYou,
    });
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain('extra-must-not-print');
    // The health probe is anonymous; only the brief request carries the bearer.
    expect(seen.find((call) => call.url.endsWith('/health'))?.authorization).toBeNull();
    expect(seen.find((call) => call.url === 'http://127.0.0.1:8010/v1/engine/brief')?.authorization).toBe(`Bearer ${token}`);
  });

  test('running but the worker is not answering yet is starting; a long-running host that stays silent is unhealthy', async () => {
    const { home, paths } = setup();
    const dead = workerFetch({});
    const base = { ...common(home), exec: launchctl('running'), fetchImpl: dead };
    expect((await engineBriefReport(base)).state).toBe('starting');
    const startedAt = Date.parse('2026-10-13T12:00:00Z');
    mkdirSync(dirname(paths.statusPath), { recursive: true });
    const writeStatus = (pid: number) => writeFileSync(paths.statusPath, JSON.stringify({
      schema: 'olympus.engine.status.v1', pid, started_at: new Date(startedAt).toISOString(), updated_at: new Date(startedAt).toISOString(),
      state: 'running', build: null, remote_mode: 'off', services: {},
    }));
    writeStatus(4242);
    expect((await engineBriefReport({ ...base, now: () => startedAt + 60_000 })).state).toBe('starting');
    const late = await engineBriefReport({ ...base, now: () => startedAt + 10 * 60_000 });
    expect(late.state).toBe('unhealthy');
    expect(late.needsYou).toBeNull();
    // A status file left by an earlier process is not evidence about this one.
    writeStatus(999);
    expect((await engineBriefReport({ ...base, now: () => startedAt + 10 * 60_000 })).state).toBe('starting');
  });

  test('worker up but the brief fails stays running with null progress and a plain detail, in every failure', async () => {
    const { home } = setup();
    const health = () => Response.json({ ok: true });
    const cases: Array<[string, typeof fetch, string]> = [
      ['500', workerFetch({ health, brief: () => new Response('boom /Users/x/secret.pdf', { status: 500 }) }), 'Olympus is running, but its progress could not be read just now.'],
      ['not a brief', workerFetch({ health, brief: () => Response.json({ hello: 'world' }) }), 'Olympus is running, but its progress could not be read just now.'],
      ['network error', workerFetch({ health }), 'Olympus is running, but its progress could not be read just now.'],
      ['401', workerFetch({ health, brief: () => new Response('{}', { status: 401 }) }), 'Olympus is running, but this command cannot read its progress. Run olympus worker status.'],
      ['404 older worker', workerFetch({ health, brief: () => new Response('{}', { status: 404 }) }), 'Olympus is running, but this version does not report progress here yet.'],
    ];
    for (const [name, fetchImpl, detail] of cases) {
      const report = await engineBriefReport({ ...common(home), exec: launchctl('running'), fetchImpl });
      expect({ name, ...report }).toEqual({ name, schema: ENGINE_BRIEF_SCHEMA, state: 'running', progress: null, blocker: null, needsYou: null, detail });
    }
  });

  test('without a bearer it still reports state and says why progress is missing', async () => {
    const { home } = setup();
    const fetchImpl = workerFetch({ health: () => Response.json({ ok: true }), brief: () => Response.json(brief) });
    const report = await engineBriefReport({ homeDir: home, platform: 'darwin', env: { HOME: home }, exec: launchctl('running'), fetchImpl });
    expect(report.state).toBe('running');
    expect(report.progress).toBeNull();
    expect(report.detail).toBe('Olympus is running, but this command cannot read its progress. Run olympus worker status.');
  });

  test('a slow brief is cut off by its timeout instead of hanging the widget', async () => {
    const { home } = setup();
    const fetchImpl = workerFetch({
      health: () => Response.json({ ok: true }),
      brief: (init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const started = Date.now();
    const report = await engineBriefReport({ ...common(home), exec: launchctl('running'), fetchImpl, briefTimeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(report.state).toBe('running');
    expect(report.detail).toBe('Olympus is running, but its progress could not be read just now.');
  });

  test('a throwing launchctl still yields the same JSON shape', async () => {
    const { home } = setup();
    const exec: EngineExec = () => { throw new Error('launchctl exploded'); };
    const report = await engineBriefReport({ ...common(home), exec, fetchImpl: workerFetch({}) });
    expect(report).toEqual({ schema: ENGINE_BRIEF_SCHEMA, state: 'unhealthy', progress: null, blocker: null, needsYou: null, detail: 'Olympus could not read its own state.' });
  });

  test('the engine command routes --brief and refuses other status options', async () => {
    const { home } = setup({ installed: false });
    const report = await runEngineCommand(['status', '--brief'], { ...common(home), exec: launchctl('absent') });
    expect(report).toMatchObject({ schema: ENGINE_BRIEF_SCHEMA, state: 'not_installed' });
    await expect(runEngineCommand(['status', '--bogus'], { ...common(home), exec: launchctl('absent') })).rejects.toThrow('Unknown engine status option');
  });
});

describe('brief platform integration', () => {
  const token = 'fixture-secret-never-print';
  const brief = { schema: ENGINE_BRIEF_SCHEMA, progress: null, blocker: null, needsYou: { count: 1, sentences: ['Dropbox — signed out'] }, token };
  function linux() {
    const home = mkdtempSync('/tmp/brief-');
    roots.push(home);
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'), XDG_RUNTIME_DIR: home, OLYMPUS_WORKER_AUTH_TOKEN: token };
    const paths = engineServicePaths({ homeDir: home, platform: 'linux', env });
    for (const path of [paths.plistPath, paths.configPath, paths.statusPath]) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(paths.plistPath, '[Service]');
    writeFileSync(paths.configPath, JSON.stringify({ email: { baseUrl: 'http://127.0.0.1:19876/v1' } }));
    writeFileSync(paths.statusPath, JSON.stringify({ schema: 'olympus.engine.status.v1', pid: 4242, started_at: '2020-01-01T00:00:00Z' }));
    const exec: EngineExec = () => ({ status: 0, stderr: '', stdout: [
      'LoadState=loaded', 'ActiveState=active', 'UnitFileState=enabled', 'MainPID=4242',
      'ControlGroup=/user.slice/engine', 'Result=success', 'ExecMainStatus=0', `FragmentPath=${paths.plistPath}`,
    ].join('\n') });
    return { homeDir: home, platform: 'linux', env, exec };
  }

  test('Linux reads the XDG unit and config with the injected transport', async () => {
    const deps = linux();
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      if (String(input).endsWith('/engine/brief')) expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return Response.json(String(input).endsWith('/health') ? { ok: true } : brief);
    }) as typeof fetch;
    const result = await runEngineCommand(['status', '--brief'], { ...deps, fetchImpl });
    expect(result).toEqual({ schema: ENGINE_BRIEF_SCHEMA, state: 'running', progress: null, blocker: null, needsYou: brief.needsYou });
    expect(seen.sort()).toEqual(['http://127.0.0.1:19876/v1/engine/brief', 'http://127.0.0.1:19876/v1/health']);
    const line = JSON.stringify(result);
    expect(line).not.toContain(token);
    expect(line).not.toContain('"token"');
    expect(line.split('\n')).toHaveLength(1);
  });

  test('Linux reads the XDG status for grace expiry on synchronous transport failure', async () => {
    const result = await engineBriefReport({ ...linux(), fetchImpl: (() => { throw new Error(token); }) as unknown as typeof fetch });
    expect(result).toMatchObject({ state: 'unhealthy', detail: 'Olympus is running but is not answering. Run olympus engine logs to see why.' });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test.skipIf(process.platform !== 'linux')('default fetch reaches only the owner socket and treats custody throws as unreachable', async () => {
    const deps = linux();
    const oldRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = deps.env.XDG_RUNTIME_DIR;
    const path = prepareWorkerSocket({ env: deps.env })!;
    const seen: string[] = [];
    const handler = withWorkerBearerAuth(withEngineBriefRoute(async () => Response.json({ ok: true }), {
      view: async () => view({ needsYou: [item('x', 'Dropbox — signed out')] }),
    }), { authToken: token, requireOwnerSocket: true });
    const server = bindWorkerSocket(path, () => Bun.serve({ unix: path, fetch: withRequestPeer(request => {
      seen.push(new URL(request.url).pathname);
      return handler(request);
    }, true) }));
    try {
      expect(await engineBriefReport(deps)).toMatchObject({ state: 'running', needsYou: brief.needsYou });
      expect(seen.sort()).toEqual(['/v1/engine/brief', '/v1/health']);
      // Exercise the actual CLI printer, not just JSON serialization of its return value.
      const bin = join(deps.homeDir, 'bin');
      mkdirSync(bin);
      const systemctl = join(bin, 'systemctl');
      writeFileSync(systemctl, "#!/bin/sh\ncat <<'FACTS'\n" + deps.exec('systemctl', []).stdout + '\nFACTS\n', { mode: 0o700 });
      const child = Bun.spawn([process.execPath, 'src/cli.ts', 'engine', 'status', '--brief'], {
        env: { ...process.env, ...deps.env, PATH: bin + ':' + process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
      });
      const printed = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(stderr).toBe('');
      expect(printed.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(printed)).toMatchObject({ schema: ENGINE_BRIEF_SCHEMA, state: 'running', needsYou: brief.needsYou });
      expect(printed).not.toContain(token);
      process.env.XDG_RUNTIME_DIR = join(deps.homeDir, 'missing');
      const failed = await engineBriefReport(deps);
      expect(failed).toMatchObject({ state: 'unhealthy', detail: 'Olympus is running but is not answering. Run olympus engine logs to see why.' });
    } finally {
      server.stop(true);
      if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = oldRuntime;
    }
  });

  test('Darwin preserves historical paths even with XDG overrides', () => {
    const home = '/Users/brief-fixture';
    expect(engineServicePaths({ homeDir: home, platform: 'darwin', env: { XDG_CONFIG_HOME: '/ignored', XDG_DATA_HOME: '/ignored' } })).toEqual(enginePaths(home));
  });
});
