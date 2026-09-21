import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCreditMonitorService } from '../src/core/native-credit-monitor-service.ts';
import type { NativeProcessServiceContext, NativeProcessServiceDefinition } from '../src/core/native-process-service.ts';
import type { VeniceCreditFetch } from '../src/core/provider-credit-status.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'venice-bundled-usage.json'), 'utf8')) as {
  balance: Record<string, unknown>;
  usage: Record<string, unknown>[];
};

const roots: string[] = [];
const services: NativeProcessServiceDefinition[] = [];
const savedAmbientKey = process.env.VENICE_API_KEY;

setDefaultTimeout(20_000);

beforeEach(() => {
  delete process.env.VENICE_API_KEY;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedAmbientKey === undefined) delete process.env.VENICE_API_KEY;
  else process.env.VENICE_API_KEY = savedAmbientKey;
});

describe('native provider credit monitor service', () => {
  test('stop cancels a start before its initial asynchronous boundary resumes', async () => {
    let calls = 0;
    const cfg = pluginConfig({ enabled: true, reportPath: join(tempRoot(), 'report.json'), credentials: { VENICE_API_KEY: 'fixture' } });
    const service = track(createNativeCreditMonitorService({ initialPluginConfig: cfg, fetchImpl: countingFetch(() => { calls += 1; }, fixture.balance) }));
    const starting = service.start({});
    await service.stop();
    await starting;
    expect(calls).toBe(0);
  });

  test('invalid interval and unexpected credential keys cannot bypass shared config validation', async () => {
    let calls = 0;
    const events: string[] = [];
    const cfg = pluginConfig({ enabled: true, reportPath: join(tempRoot(), 'report.json'), intervalSeconds: 1, credentials: { VENICE_API_KEY: 'fixture', UNEXPECTED: 'fixture' } });
    const service = track(createNativeCreditMonitorService({ initialPluginConfig: cfg, fetchImpl: countingFetch(() => { calls += 1; }, fixture.balance) }));
    await service.start(context(events, cfg));
    expect(calls).toBe(0);
    expect(events).toEqual(['failure:Olympus credit monitor configuration is invalid or contains unresolved credentials.']);
  });

  test('malformed credentials cannot be echoed into a persisted billing report', async () => {
    const reportPath = join(tempRoot(), 'report.json');
    const key = 'synthetic-secret\ninvalid';
    const cfg = pluginConfig({ enabled: true, reportPath, credentials: { VENICE_API_KEY: key } });
    const service = track(createNativeCreditMonitorService({
      initialPluginConfig: cfg,
      fetchImpl: async (_url, init) => { new Headers(init.headers); throw new Error('unreachable'); },
    }));
    await service.start({});
    await waitFor(() => existsSync(reportPath));
    const raw = readFileSync(reportPath, 'utf8');
    expect(raw).not.toContain('synthetic-secret');
    expect(raw).not.toContain('invalid header');
    expect(JSON.parse(raw).error_message).toBe('Venice billing request failed.');
  });

  test('report and pause path collisions are rejected before any fetch or write', async () => {
    const root = tempRoot();
    const pauseFile = join(root, 'status.json');
    const previous = JSON.stringify({ kind: 'venice', active: true });
    writeFileSync(pauseFile, previous);
    let calls = 0;
    const events: string[] = [];
    const cfg = pluginConfig({ enabled: true, reportPath: root + '/nested/../status.json', pauseFile, credentials: { VENICE_API_KEY: 'fixture' } });
    const service = track(createNativeCreditMonitorService({ initialPluginConfig: cfg, fetchImpl: countingFetch(() => { calls += 1; }, fixture.balance) }));
    await service.start(context(events, cfg));
    expect(calls).toBe(0);
    expect(readFileSync(pauseFile, 'utf8')).toBe(previous);
    expect(events).toEqual(['failure:Olympus credit monitor configuration is invalid or contains unresolved credentials.']);
  });

  test('declares the credit-monitor identity and reload prefix', () => {
    const service = createNativeCreditMonitorService({ initialPluginConfig: {} });
    expect(service.id).toBe('olympus-provider-credit-monitor');
    expect(service.reload.configPrefixes).toEqual([
      'plugins.entries.olympus.config.worker.creditMonitor',
    ]);
  });

  test('stays idle while the credit monitor is disabled', async () => {
    let calls = 0;
    const service = track(createNativeCreditMonitorService({
      initialPluginConfig: pluginConfig({ enabled: false, reportPath: join(tempRoot(), 'report.json') }),
      fetchImpl: countingFetch(() => { calls += 1; }, fixture.balance),
    }));

    await service.start({});
    await Bun.sleep(50);

    expect(calls).toBe(0);
  });

  test('fresh runtime config wins over the registration snapshot, and a removed entry disables', async () => {
    const staleRoot = tempRoot();
    const freshRoot = tempRoot();
    const staleReport = join(staleRoot, 'status.json');
    const freshReport = join(freshRoot, 'status.json');
    const service = track(createNativeCreditMonitorService({
      initialPluginConfig: pluginConfig({
        enabled: true,
        reportPath: staleReport,
        credentials: { VENICE_API_KEY: 'secret-token' },
      }),
      fetchImpl: healthyFetch(fixture.balance),
    }));

    await service.start({ config: entryContext(pluginConfig({
      enabled: true,
      reportPath: freshReport,
      credentials: { VENICE_API_KEY: 'secret-token' },
    })) });
    await waitFor(() => existsSync(freshReport));

    expect(existsSync(staleReport)).toBe(false);
    expect(existsSync(freshReport)).toBe(true);

    // A reload that removes the plugin entry must not resurrect the snapshot.
    await service.start({ config: { plugins: { entries: { olympus: {} } } } });
    await Bun.sleep(80);

    expect(existsSync(join(freshRoot, 'status.json'))).toBe(true);
    expect(existsSync(join(staleRoot, 'status.json'))).toBe(false);
  });

  test('never falls back to an ambient provider key', async () => {
    process.env.VENICE_API_KEY = 'ambient-venice-token';
    const root = tempRoot();
    const reportPath = join(root, 'status.json');
    const events: string[] = [];
    let calls = 0;
    const service = track(createNativeCreditMonitorService({
      initialPluginConfig: pluginConfig({ enabled: true, reportPath }),
      fetchImpl: countingFetch(() => { calls += 1; }, fixture.balance),
    }));

    await service.start(context(events, pluginConfig({ enabled: true, reportPath })));
    await Bun.sleep(80);

    expect(calls).toBe(0);
    expect(existsSync(reportPath)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('VENICE_API_KEY');
    expect(events[0]).not.toContain('ambient-venice-token');
  });

  test('stop during an in-flight fetch aborts and never publishes a late report', async () => {
    const root = tempRoot();
    const reportPath = join(root, 'status.json');
    const events: string[] = [];
    const started = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls += 1;
      started.resolve();
      await release.promise;
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return String(url).endsWith('/billing/balance')
        ? Response.json(fixture.balance)
        : Response.json({ data: [], pagination: { page: 1, totalPages: 1 } });
    }) as unknown as VeniceCreditFetch;
    const service = track(createNativeCreditMonitorService({
      initialPluginConfig: pluginConfig({
        enabled: true,
        reportPath,
        credentials: { VENICE_API_KEY: 'secret-token' },
      }),
      fetchImpl,
    }));

    await service.start(context(events, pluginConfig({
      enabled: true,
      reportPath,
      credentials: { VENICE_API_KEY: 'secret-token' },
    })));
    await started.promise;
    const stopped = service.stop();
    release.resolve();
    await stopped;

    expect(calls).toBe(1);
    expect(existsSync(reportPath)).toBe(false);
    expect(events).toEqual([]);
  });

  test('publishes a private report and the pause marker, reporting exhaustion categorically', async () => {
    const root = tempRoot();
    const reportPath = join(root, 'status.json');
    const pauseFile = join(root, 'venice-paused.json');
    const events: string[] = [];
    const service = track(createNativeCreditMonitorService({
      initialPluginConfig: pluginConfig({
        enabled: true,
        reportPath,
        pauseFile,
        credentials: { VENICE_API_KEY: 'secret-token' },
      }),
      fetchImpl: healthyFetch({ canConsume: false, consumptionCurrency: 'BUNDLED_CREDITS', balances: { usd: 0 } }),
    }));

    await service.start(context(events, pluginConfig({
      enabled: true,
      reportPath,
      pauseFile,
      credentials: { VENICE_API_KEY: 'secret-token' },
    })));
    await waitFor(() => existsSync(pauseFile));

    const rawReport = readFileSync(reportPath, 'utf8');
    expect(JSON.parse(rawReport)).toMatchObject({ kind: 'venice_credit_status', status: 'credit_exhausted', can_consume: false });
    expect(rawReport).not.toContain('secret-token');
    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pauseFile, 'utf8'))).toMatchObject({
      active: true,
      kind: 'venice',
      reason: 'provider_credit_exhausted',
    });
    expect(events.at(-1)).toContain('credit_exhausted');
    expect(events.at(-1)).not.toContain('secret-token');
  });

  test('clears health and the pause marker once the balance is healthy again', async () => {
    const root = tempRoot();
    const reportPath = join(root, 'status.json');
    const pauseFile = join(root, 'venice-paused.json');
    writeFileSync(pauseFile, '{"kind":"venice"}\n');
    const events: string[] = [];
    const service = track(createNativeCreditMonitorService({
      initialPluginConfig: pluginConfig({
        enabled: true,
        reportPath,
        pauseFile,
        credentials: { VENICE_API_KEY: 'secret-token' },
      }),
      fetchImpl: healthyFetch(fixture.balance),
    }));

    await service.start(context(events, pluginConfig({
      enabled: true,
      reportPath,
      pauseFile,
      credentials: { VENICE_API_KEY: 'secret-token' },
    })));
    await waitFor(() => existsSync(reportPath));

    expect(existsSync(pauseFile)).toBe(false);
    expect(events).toEqual(['cleared']);
  });

  test('ticks immediately and never overlaps a tick with its predecessor', async () => {
    const root = tempRoot();
    const reportPath = join(root, 'status.json');
    const releaseFirst = deferred<void>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await releaseFirst.promise;
      active -= 1;
      return String(url).endsWith('/billing/balance')
        ? Response.json(fixture.balance)
        : Response.json({ data: [], pagination: { page: 1, totalPages: 1 } });
    }) as unknown as VeniceCreditFetch;
    const service = track(createNativeCreditMonitorService({
      intervalMs: 1_000,
      initialPluginConfig: pluginConfig({
        enabled: true,
        reportPath,
        intervalSeconds: 60,
        credentials: { VENICE_API_KEY: 'secret-token' },
      }),
      fetchImpl,
    }));

    await service.start(context([], pluginConfig({
      enabled: true,
      reportPath,
      intervalSeconds: 60,
      credentials: { VENICE_API_KEY: 'secret-token' },
    })));
    await waitFor(() => calls === 1);
    expect(existsSync(reportPath)).toBe(false);

    // The first tick is still in flight past one full interval: a scheduler that
    // fired on the clock instead of on completion would have started a second.
    await Bun.sleep(1_100);
    expect(calls).toBe(1);

    releaseFirst.resolve();
    await waitFor(() => calls === 2);
    expect(maxActive).toBe(1);
  });
});

function pluginConfig(input: {
  enabled: boolean;
  reportPath?: string;
  pauseFile?: string;
  intervalSeconds?: number;
  credentials?: Record<string, string>;
}): unknown {
  return {
    worker: {
      creditMonitor: {
        enabled: input.enabled,
        provider: 'venice',
        intervalSeconds: input.intervalSeconds ?? 3_600,
        ...(input.reportPath ? { reportPath: input.reportPath } : {}),
        ...(input.pauseFile ? { pauseFile: input.pauseFile } : {}),
        credentials: input.credentials ?? {},
      },
    },
  };
}

function entryContext(pluginConfigValue: unknown): unknown {
  return { plugins: { entries: { olympus: { config: pluginConfigValue } } } };
}

function context(events: string[], pluginConfigValue: unknown): NativeProcessServiceContext {
  return {
    config: entryContext(pluginConfigValue),
    serviceHealth: {
      reportFailure(error: Error) { events.push(`failure:${error.message}`); },
      clearFailure() { events.push('cleared'); },
    },
  };
}

function track(service: NativeProcessServiceDefinition): NativeProcessServiceDefinition {
  services.push(service);
  return service;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-credit-monitor-'));
  roots.push(root);
  return root;
}

function healthyFetch(balance: unknown): VeniceCreditFetch {
  return (async (url: string) => String(url).endsWith('/billing/balance')
    ? Response.json(balance)
    : Response.json({ data: [], pagination: { page: 1, totalPages: 1 } })) as unknown as VeniceCreditFetch;
}

function countingFetch(onCall: () => void, balance: unknown): VeniceCreditFetch {
  return (async (url: string) => {
    onCall();
    return String(url).endsWith('/billing/balance')
      ? Response.json(balance)
      : Response.json({ data: [], pagination: { page: 1, totalPages: 1 } });
  }) as unknown as VeniceCreditFetch;
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle as (value?: T) => void; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for the credit monitor fixture state.');
}
