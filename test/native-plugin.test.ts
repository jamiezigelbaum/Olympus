import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import plugin, {
  handleSourceWatchDeliveryGatewayRequest,
  sendOpenClawSourceWatchDelivery,
  sourceWatchRouteFromToolContext,
} from '../src/native-plugin.ts';
import manifest from '../openclaw.plugin.json';
import pkg from '../package.json';
import {
  V0_4_PUBLIC_NATIVE_TOOLS,
  V0_4_PUBLIC_SOURCE_IDS,
} from '../src/core/public-surface.ts';
import type { NativeWorkerServiceDefinition } from '../src/core/native-worker-service.ts';

const originalFetch = globalThis.fetch;

interface NativeTool {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

function materializeTool(tool: NativeTool): NativeTool {
  if (typeof tool !== 'function') return tool;
  return (tool as unknown as (context: Record<string, unknown>) => NativeTool)({
    agentId: 'castor',
    sessionId: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
    requesterSenderId: 'owner-1',
    senderIsOwner: true,
    deliveryContext: { channel: 'telegram', to: '123456789', accountId: 'castor' },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected schema object.');
  }
  return value as Record<string, unknown>;
}

function configSchemaProperties(path: readonly string[] = []): Record<string, unknown> {
  let node = asRecord(manifest.configSchema);
  for (const segment of path) {
    const properties = asRecord(node.properties);
    node = asRecord(properties[segment]);
  }
  return asRecord(node.properties);
}

function registeredToolNames(pluginConfig: unknown, apiExtra: Record<string, unknown> = {}): string[] {
  const names: string[] = [];
  plugin.register({
    ...apiExtra,
    pluginConfig,
    registerTool(tool: NativeTool) {
      names.push(materializeTool(tool).name);
    },
  });
  return names;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('native OpenClaw plugin adapter', () => {
  test('inspects an enabled native service with opaque refs without using ambient worker auth', async () => {
    const ref = { source: 'env', provider: 'default', id: 'WORKER_SECRET' };
    const pluginConfig = {
      worker: {
        authToken: ref,
        service: { enabled: true, credentials: { GEMINI_API_KEY: ref } },
        telegramCapture: {
          enabled: true,
          credentials: {
            OLYMPUS_TELEGRAM_API_ID: ref,
            OLYMPUS_TELEGRAM_API_HASH: ref,
          },
        },
        embeddingDrain: {
          enabled: true,
          credentials: { OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: ref },
        },
      },
    };
    const tools: NativeTool[] = [];
    const services: NativeWorkerServiceDefinition[] = [];
    let requests = 0;
    const ambient = process.env.OLYMPUS_WORKER_AUTH_TOKEN;
    process.env.OLYMPUS_WORKER_AUTH_TOKEN = 'ambient-credential';
    globalThis.fetch = (async () => { requests += 1; throw new Error('unexpected transport'); }) as unknown as typeof fetch;
    try {
      plugin.register({
        pluginConfig,
        registerTool(tool: NativeTool) { tools.push(materializeTool(tool)); },
        registerService(service: NativeWorkerServiceDefinition) { services.push(service); },
      });
      expect(tools.map((tool) => tool.name)).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
      expect(services).toHaveLength(7);
      const result = await tools.find((tool) => tool.name === 'source_index_status')!.execute('opaque-ref-test', {});
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain('has not been resolved');
      expect(JSON.stringify(result)).not.toContain('ambient-credential');
      expect(requests).toBe(0);
      const failures: string[] = [];
      for (const service of services) await service.start({
        config: { plugins: { entries: { olympus: { config: pluginConfig } } } },
        serviceHealth: { reportFailure(error) { failures.push(error.message); }, clearFailure() {} },
      });
      await Bun.sleep(10);
      expect(failures.some((message) => message.includes('failed to become ready'))).toBe(true);
      expect(failures.some((message) => message.includes('configuration is invalid or contains unresolved credentials'))).toBe(true);
      expect(requests).toBe(0);

    } finally {
      if (ambient === undefined) delete process.env.OLYMPUS_WORKER_AUTH_TOKEN;
      else process.env.OLYMPUS_WORKER_AUTH_TOKEN = ambient;
      await Promise.all(services.map((service) => service.stop()));
    }
  });

  test('inspects opaque provider credentials but refuses them at native startup', async () => {
    const pluginConfig = { worker: { authToken: 'explicit-worker-credential', service: { enabled: true, credentials: { GEMINI_API_KEY: { source: 'env', provider: 'default', id: 'GEMINI_SECRET' } } } } };
    const services: NativeWorkerServiceDefinition[] = [];
    expect(registeredToolNames(pluginConfig, { registerService(service: NativeWorkerServiceDefinition) { services.push(service); } })).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    const failures: string[] = [];
    await services[0]!.start({
      config: { plugins: { entries: { olympus: { config: pluginConfig } } } },
      serviceHealth: { reportFailure(error) { failures.push(error.message); }, clearFailure() {} },
    });
    await Bun.sleep(10);
    expect(failures.some((message) => message.includes('failed to become ready'))).toBe(true);

    await services[0]!.stop();
  });

  test('registers the opt-in worker supervisor with config reload ownership', () => {
    const services: NativeWorkerServiceDefinition[] = [];
    plugin.register({
      pluginConfig: {},
      registerTool() {},
      registerService(service: NativeWorkerServiceDefinition) {
        services.push(service);
      },
    });

    expect(services).toEqual([
      {
        id: 'olympus-worker',
        reload: {
          configPrefixes: [
            'plugins.entries.olympus.config.worker',
            'plugins.entries.olympus.config.email.baseUrl',
            'plugins.entries.olympus.config.sourceIndex',
            'plugins.entries.olympus.config.sovereignty',
          ],
        },
        start: expect.any(Function),
        stop: expect.any(Function),
      },
      {
        id: 'olympus-telegram-capture',
        reload: {
          configPrefixes: ['plugins.entries.olympus.config.worker', 'plugins.entries.olympus.config.email.baseUrl', 'plugins.entries.olympus.config.sourceIndex', 'plugins.entries.olympus.config.sovereignty'],
        },
        start: expect.any(Function),
        stop: expect.any(Function),
      },
      {
        id: 'olympus-provider-credit-monitor',
        reload: { configPrefixes: ['plugins.entries.olympus.config.worker.creditMonitor'] },
        start: expect.any(Function),
        stop: expect.any(Function),
      },
      {
        id: 'olympus-whatsapp-capture',
        reload: {
          configPrefixes: ['plugins.entries.olympus.config.worker', 'plugins.entries.olympus.config.email.baseUrl', 'plugins.entries.olympus.config.sourceIndex', 'plugins.entries.olympus.config.sovereignty'],
        },
        start: expect.any(Function),
        stop: expect.any(Function),
      },
      {
        id: 'olympus-source-embedding-drain',
        reload: {
          configPrefixes: ['plugins.entries.olympus.config.worker.embeddingDrain'],
        },
        start: expect.any(Function),
        stop: expect.any(Function),
      },
      {
        id: 'olympus-transcription-temp-cleanup',
        reload: { configPrefixes: ['plugins.entries.olympus.config.worker.transcriptionCleanup'] },
        start: expect.any(Function), stop: expect.any(Function),
      },
      {
        id: 'olympus-remote-relay',
        reload: {
          configPrefixes: [
            'plugins.entries.olympus.config.remote',
            'plugins.entries.olympus.config.email.baseUrl',
            'plugins.entries.olympus.config.worker.service',
          ],
        },
        start: expect.any(Function),
        stop: expect.any(Function),
      },
    ]);
  });

  test('derives watch ownership only from authenticated caller context', () => {
    const first = sourceWatchRouteFromToolContext({
      agentId: 'castor', requesterSenderId: 'owner-1', senderIsOwner: true,
      deliveryContext: { channel: 'telegram', to: '12345' },
    });
    const second = sourceWatchRouteFromToolContext({
      agentId: 'castor', requesterSenderId: 'owner-2', senderIsOwner: true,
      deliveryContext: { channel: 'telegram', to: '67890' },
    });
    expect(first).toMatchObject({ routeKind: 'openclaw_channel', routeTargetId: 'telegram:12345' });
    expect(first?.ownerId).not.toBe(second?.ownerId);
    expect(sourceWatchRouteFromToolContext({
      requesterSenderId: 'owner-1', senderIsOwner: false,
      deliveryContext: { channel: 'telegram', to: '12345' },
    })).toBeUndefined();
  });

  test('binds watch delivery to the durable SDK with an evidence-pointer-only Telegram payload', async () => {
    const calls: Record<string, unknown>[] = [];
    const idempotencyKey = 'a'.repeat(64);
    const result = await sendOpenClawSourceWatchDelivery({
      openClawConfig: { gateway: { port: 18789 } },
      route: { kind: 'openclaw_channel', targetId: 'telegram:12345', accountId: 'castor' },
      downstreamIdempotencyKey: idempotencyKey,
      payload: {
        headline: 'Olympus watch matched newly indexed evidence.',
        watch_id: 'watch-native',
        corpus_id: 'internal.telegram.messages',
        query_text: 'pineapple',
        watch_mode: 'one_shot',
        match_count: 1,
        items: [{
          local_item_id: 'message-1',
          source_version: '2026-07-22T09:50:00.000Z',
          matched_at: '2026-07-22T10:00:00.000Z',
        }],
      },
      sendDurableMessageBatch: async (params) => {
        calls.push(params);
        return {
          status: 'sent',
          receipt: { platformMessageIds: ['telegram-platform-1'], sentAt: 1_753_178_400_000 },
        };
      },
    });

    expect(calls).toEqual([expect.objectContaining({
      cfg: { gateway: { port: 18789 } },
      channel: 'telegram',
      to: '12345',
      accountId: 'castor',
      durability: 'required',
      bestEffort: false,
      payloads: [{
        text: [
          'Olympus: your watch for "pineapple" matched 1 newly indexed item in internal.telegram.messages.',
          'Item authored 2026-07-22 09:50 UTC; indexed and matched 2026-07-22 10:00 UTC.',
          'This was a one-shot watch — it is now complete.',
          'ref: watch watch-na · item message-1',
        ].join('\n'),
      }],
    })]);
    expect(JSON.stringify(calls[0])).not.toContain(idempotencyKey);
    expect(result).toEqual({
      status: 'sent',
      downstream_idempotency_key: idempotencyKey,
      downstream_idempotency: 'unsupported_by_openclaw_sdk',
      receipt: {
        platform_message_ids: ['telegram-platform-1'],
        sent_at_ms: 1_753_178_400_000,
      },
    });
  });

  test('protects the worker-to-gateway delivery route with shared bearer auth and strict targets', async () => {
    let sends = 0;
    const body = JSON.stringify({
      route: {
        ownerId: 'owner:hash',
        kind: 'openclaw_channel',
        targetId: 'telegram:12345',
        accountId: 'castor',
      },
      downstream_idempotency_key: 'b'.repeat(64),
      payload: {
        headline: 'Olympus watch matched newly indexed evidence.',
        watch_id: 'watch-route',
        corpus_id: 'internal.telegram.messages',
        query_text: 'pineapple',
        watch_mode: 'continuous',
        match_count: 1,
        items: [{
          local_item_id: 'message-1',
          source_version: '2026-07-22T09:50:00.000Z',
          matched_at: '2026-07-22T10:00:00.000Z',
        }],
      },
    });
    const sendDurableMessageBatch = async () => {
      sends += 1;
      return { status: 'sent' as const, receipt: { platformMessageIds: ['message-1'] } };
    };

    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer wrong', body,
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 401, body: { error_kind: 'unauthorized' } });
    expect(sends).toBe(0);

    const invalidTarget = JSON.parse(body) as { route: { targetId: string } };
    invalidTarget.route.targetId = 'email:12345';
    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body: JSON.stringify(invalidTarget),
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 400, body: { error_kind: 'invalid_request' } });
    expect(sends).toBe(0);

    const unknownPayloadField = JSON.parse(body) as { payload: Record<string, unknown> };
    unknownPayloadField.payload.source_text = 'must stay out';
    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body: JSON.stringify(unknownPayloadField),
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 400, body: { error_kind: 'invalid_request' } });
    expect(sends).toBe(0);

    const overLengthQuery = JSON.parse(body) as { payload: { query_text: string } };
    overLengthQuery.payload.query_text = 'x'.repeat(4_097);
    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body: JSON.stringify(overLengthQuery),
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({ status: 400, body: { error_kind: 'invalid_request' } });
    expect(sends).toBe(0);

    expect(await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST', authorization: 'Bearer shared-worker-token', body,
      authToken: 'shared-worker-token', openClawConfig: {}, sendDurableMessageBatch,
    })).toMatchObject({
      status: 200,
      body: {
        status: 'sent',
        downstream_idempotency: 'unsupported_by_openclaw_sdk',
        receipt: { platform_message_ids: ['message-1'] },
      },
    });
    expect(sends).toBe(1);
  });

  test('registers the native durable delivery route when hosted by OpenClaw', () => {
    const routes: Array<Record<string, unknown>> = [];
    plugin.register({
      config: {},
      pluginConfig: { worker: { authToken: 'shared-worker-token' } },
      registerTool() {},
      registerHttpRoute(route) {
        routes.push(route as unknown as Record<string, unknown>);
      },
    });
    expect(routes).toEqual([expect.objectContaining({
      path: '/plugins/olympus/watch-delivery',
      auth: 'plugin',
      match: 'exact',
      handler: expect.any(Function),
    })]);
  });

  test('tool calls and watch delivery use the worker.env token current at each request', async () => {
    // First install, 2026-09-23: the Gateway registered the plugin before setup
    // minted the worker token, captured none, and every tool call then got 401
    // from the worker setup started until a manual Gateway restart.
    const home = mkdtempSync(join(tmpdir(), 'olympus-plugin-token-reload-'));
    const envPath = join(home, '.config', 'olympus', 'worker.env');
    mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
    const writeToken = (token: string) => writeFileSync(envPath, `OLYMPUS_WORKER_AUTH_TOKEN=${token}\n`, { mode: 0o600 });
    const savedHome = process.env.HOME;
    const savedToken = process.env.OLYMPUS_WORKER_AUTH_TOKEN;
    process.env.HOME = home;
    delete process.env.OLYMPUS_WORKER_AUTH_TOKEN;
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get('Authorization'));
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    const tools = new Map<string, NativeTool>();
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = [];
    try {
      plugin.register({
        config: {},
        pluginConfig: { email: { enabled: true, baseUrl: 'http://source-worker.test/v1' } },
        registerTool(tool: NativeTool) {
          const materialized = materializeTool(tool);
          tools.set(materialized.name, materialized);
        },
        registerHttpRoute(route) {
          routes.push(route as unknown as (typeof routes)[number]);
        },
      });
      const ask = () => tools.get('source_answer')!.execute('token-reload', { question: 'q' });
      const deliver = async (authorization: string) => {
        const request = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'GET', headers: { authorization } });
        const response = { statusCode: 0, setHeader() {}, end(body: string) { this.body = body; }, body: '' };
        await routes[0]!.handler(request, response);
        return JSON.parse(response.body).error_kind as string;
      };

      await ask();
      expect(await deliver('Bearer first-token')).toBe('watch_delivery_auth_unconfigured');
      writeToken('first-token');
      await ask();
      expect(await deliver('Bearer first-token')).toBe('method_not_allowed');
      writeToken('rotated-token');
      await ask();
      expect(await deliver('Bearer first-token')).toBe('unauthorized');
      expect(await deliver('Bearer rotated-token')).toBe('method_not_allowed');
      expect(authorizations).toEqual([null, 'Bearer first-token', 'Bearer rotated-token']);

      // An explicit plugin credential still outranks worker.env.
      const pinned = new Map<string, NativeTool>();
      plugin.register({
        pluginConfig: { email: { enabled: true, baseUrl: 'http://source-worker.test/v1' }, worker: { authToken: 'config-token' } },
        registerTool(tool: NativeTool) {
          const materialized = materializeTool(tool);
          pinned.set(materialized.name, materialized);
        },
      });
      await pinned.get('source_answer')!.execute('token-pinned', { question: 'q' });
      expect(authorizations.at(-1)).toBe('Bearer config-token');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedToken === undefined) delete process.env.OLYMPUS_WORKER_AUTH_TOKEN;
      else process.env.OLYMPUS_WORKER_AUTH_TOKEN = savedToken;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('uses a built JavaScript runtime entrypoint for OpenClaw installation', () => {
    expect(pkg.openclaw.extensions).toEqual(['./dist/index.js']);
    expect(pkg.openclaw.runtimeExtensions).toEqual(['./dist/index.js']);
    expect(pkg.openclaw.runtimeExtensions).toEqual(pkg.openclaw.extensions);
  });

  test('packaged OpenClaw runtime entrypoint imports and registers tools', async () => {
    const extensionPath = pkg.openclaw.extensions[0];
    if (!extensionPath) throw new Error('Missing OpenClaw extension entrypoint.');
    const packaged = await import(`../${extensionPath.replace(/^\.\//, '')}`) as { default: typeof plugin };
    const names: string[] = [];

    packaged.default.register({
      pluginConfig: {},
      registerTool(tool: NativeTool) {
        names.push(materializeTool(tool).name);
      },
    });

    expect(names).toEqual(registeredToolNames({}));
  });

  test('keeps source-checkout licensing and release version metadata aligned', () => {
    expect(pkg).toMatchObject({ name: 'olympus-source-checkout', private: true });
    expect(pkg.license).toBe('MIT');
    expect(pkg.version).toBe('0.4.0-beta.5');
    expect(manifest.version).toBe(pkg.version);
  });

  test('declares runtime-supported config fields in the OpenClaw schema', () => {
    expect(Object.keys(configSchemaProperties())).toEqual(expect.arrayContaining([
      'identity',
      'worker',
      'sourceIndex',
    ]));
    expect(Object.keys(configSchemaProperties(['identity']))).toEqual(expect.arrayContaining([
      'ownerName',
      'assistantName',
    ]));
    expect(Object.keys(configSchemaProperties(['worker']))).toEqual(expect.arrayContaining([
      'authToken',
      'service',
      'creditMonitor',
      'telegramCapture',
      'whatsappCapture',
      'embeddingDrain',
      'transcriptionCleanup',
      'scheduler',
    ]));
    expect(Object.keys(configSchemaProperties(['worker', 'service']))).toEqual(expect.arrayContaining([
      'enabled',
      'startupTimeoutSeconds',
      'credentials',
      'runtimePath',
      'executablePath',
    ]));
    expect(Object.keys(configSchemaProperties(['worker', 'telegramCapture']))).toEqual(expect.arrayContaining([
      'enabled',
      'credentials',
      'pythonPath',
      'sessionPath',
      'stateDir',
      'spoolDir',
      'reportPath',
    ]));
    expect(Object.keys(asRecord(configSchemaProperties(['worker', 'telegramCapture']).credentials).properties as Record<string, unknown>))
      .toEqual(['OLYMPUS_TELEGRAM_API_ID', 'OLYMPUS_TELEGRAM_API_HASH']);
    expect(Object.keys(configSchemaProperties(['worker', 'whatsappCapture']))).toEqual([
      'enabled',
      'binaryPath',
      'stateDir',
    ]);
    expect(Object.keys(configSchemaProperties(['worker', 'embeddingDrain']))).toEqual([
      'enabled',
      'credentials',
      'runtimePath',
      'environmentPath',
      'reportPath',
    ]);
    expect(Object.keys(asRecord(configSchemaProperties(['worker', 'embeddingDrain']).credentials).properties as Record<string, unknown>))
      .toEqual(['GEMINI_API_KEY', 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY']);
    expect(Object.keys(configSchemaProperties(['worker', 'scheduler']))).toEqual(expect.arrayContaining([
      'enabled',
      'sourceIds',
      'tickSeconds',
      'syncIntervalSeconds',
      'freshnessThresholdHours',
      'errorBackoffSeconds',
      'maxTransientRetries',
    ]));
    expect(asRecord(configSchemaProperties(['worker', 'scheduler']).sourceIds)).toMatchObject({
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [...V0_4_PUBLIC_SOURCE_IDS],
      },
    });
    expect(Object.keys(configSchemaProperties(['argus', 'lanes', 'fast']))).toEqual(expect.arrayContaining([
      'baseUrl',
      'model',
      'secretRef',
    ]));
    expect(Object.keys(configSchemaProperties(['argus', 'lanes', 'deep']))).toEqual(expect.arrayContaining([
      'baseUrl',
      'model',
      'secretRef',
    ]));
    const argusModelProfileProperties = configSchemaProperties(['argus', 'modelProfiles', 'default_chat']);
    expect(Object.keys(argusModelProfileProperties)).toEqual(expect.arrayContaining([
      'baseUrl',
      'model',
      'secretRef',
      'purpose',
    ]));
    expect(Object.keys(argusModelProfileProperties)).not.toContain('apiKey');
    expect(Object.keys(argusModelProfileProperties)).not.toContain('clientSecret');
    expect(Object.keys(configSchemaProperties(['sourceIndex']))).toEqual(expect.arrayContaining([
      'enabled',
      'corpusRegistry',
      'corpora',
      'ingestionPolicies',
    ]));
    // Inlined, not $ref: the Control UI form renderer cannot follow references.
    const corpusItems = asRecord(asRecord(configSchemaProperties(['sourceIndex']).corpora).items);
    expect(Object.keys(asRecord(corpusItems.properties))).toEqual(expect.arrayContaining(['corpusId', 'sourceId', 'trustDomain']));
    expect(asRecord(asRecord(configSchemaProperties(['sourceIndex', 'corpusRegistry']).corpora).items)).toEqual(corpusItems);
    expect(Object.keys(configSchemaProperties(['sourceIndex', 'ingestionPolicies', 'dropboxPersonal']))).toEqual(expect.arrayContaining([
      'policyPath',
      'policy',
      'schemaVersion',
      'source',
      'corpusId',
      'roots',
      'rules',
      'sync',
      'content',
    ]));
  });

  test('declares Gateway SecretRef resolution for native worker credentials', () => {
    expect(manifest.configContracts.secretInputs.paths).toEqual([
      { path: 'worker.authToken', expected: 'string' },
      { path: 'worker.service.credentials.*', expected: 'string' },
      { path: 'worker.telegramCapture.credentials.*', expected: 'string' },
      { path: 'worker.creditMonitor.credentials.*', expected: 'string' },
      { path: 'worker.embeddingDrain.credentials.*', expected: 'string' },
    ]);
    const secretInput = configSchemaProperties(['worker']).authToken;
    expect(asRecord(secretInput).oneOf).toEqual([
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', enum: ['env', 'file', 'exec'] },
          provider: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['source', 'provider', 'id'],
      },
    ]);
  });

  test('loads at gateway startup so agent runtime tools are callable', () => {
    expect(manifest.activation.onStartup).toBe(true);
  });

  test('declares the native tool contract required by current OpenClaw', () => {
    const registeredToolNames: string[] = [];

    plugin.register({
      pluginConfig: {},
      registerTool(tool: NativeTool) {
        registeredToolNames.push(materializeTool(tool).name);
      },
    });

    expect(manifest.contracts.tools).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    expect(registeredToolNames).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'source_answer',
      'source_index_status',
      'source_index_search',
      'source_watch_create',
      'source_watches',
      'source_watch_cancel',
      'olympus_doctor',
    ]);
  });

  test('can disable the promoted source-index read tools', () => {
    // sourceIndex.enabled is the only switch left: the legacy
    // sourceIndex.answerDevEnabled proof gate was deleted on 2026-09-18 with
    // the tools it opened, so an install that turns the read surface off is
    // left with Argus and the doctor.
    const disabled = registeredToolNames({
      sourceIndex: {
        enabled: false,
      },
    });
    expect(disabled).not.toContain('source_answer');
    expect(disabled).not.toContain('source_index_status');
    expect(disabled).not.toContain('source_index_search');
    expect(disabled).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'olympus_doctor',
    ]);
  });

  test('the registered roster does not vary with host-supplied context', () => {
    // Olympus once gated private tools on the host's active-model metadata.
    // Those tools and the gate were deleted on 2026-09-18, so the roster is a
    // function of config alone: whatever extra shapes a host hands `register`,
    // the public tools are what get registered.
    const hostShapes: Array<Record<string, unknown>> = [
      {},
      { activeModel: { provider: 'openai-codex', modelId: 'gpt-5.5' } },
      { context: { activeModel: { provider: 'olympus-local', modelId: 'local-qwen-fast' } } },
      { toolContext: { activeModel: { modelRef: 'olympus-local/local-qwen-fast' } } },
    ];
    for (const shape of hostShapes) {
      expect(registeredToolNames({ argus: { lanes: { fast: { model: 'local-qwen-fast' } } } }, shape))
        .toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    }
  });

  test('uses nested argus plugin config for tool execution', async () => {
    const calls: Array<{ url: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response(
        JSON.stringify({
          model: 'configured-fast-model',
          choices: [{ message: { content: 'configured response' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tools = new Map<string, NativeTool>();
    plugin.register({
      pluginConfig: {
        argus: {
          defaultLane: 'fast',
          lanes: {
            fast: {
              baseUrl: 'http://gateway-local.test/v1',
              model: 'configured-fast-model',
            },
          },
        },
      },
      registerTool(tool: NativeTool) {
        const materialized = materializeTool(tool);
        tools.set(materialized.name, materialized);
      },
    });

    const result = await tools.get('argus_complete')?.execute('tool-call-1', { prompt: 'hello' });

    expect(calls[0]?.url).toBe('http://gateway-local.test/v1/chat/completions');
    expect(JSON.parse(calls[0]?.body ?? '{}').model).toBe('configured-fast-model');
    expect(result).toMatchObject({
      details: {
        text: 'configured response',
        profile: 'default_chat',
        model: 'configured-fast-model',
      },
    });
  });

  test('renders source_answer as compact answer-ready text while preserving details', async () => {
    const calls: Array<{ url: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response(
        JSON.stringify({
          answer: 'LDL is elevated, while the Telegram source discusses ApoB as a biomarker. [1][2]',
          evidence: [
            {
              corpus_id: 'secure_local.dropbox.files',
              trust_domain: 'secure_local',
              family: 'dropbox',
              provider: 'dropbox',
              provider_item_id: 'hashed-dropbox-item',
              title: 'Recent Labs.pdf',
              source_label: 'Recent Labs',
              updated_at: '2026-06-01T10:00:00Z',
            },
            {
              corpus_id: 'internal.telegram.messages',
              trust_domain: 'internal',
              family: 'telegram',
              provider: 'telegram',
              provider_item_id: 'hashed-telegram-message',
              source_label: 'Happy Fourth Crypto Bear',
              authored_at: '2026-05-15T12:00:00Z',
            },
          ],
          audit: {
            searched_corpora: ['secure_local.dropbox.files', 'internal.telegram.messages'],
            skipped_corpora: [
              {
                corpus_id: 'internal.email',
                trust_domain: 'internal',
                reason: 'not_requested',
              },
            ],
            lane_audits: [
              {
                laneName: 'source_answer:retrieval',
                diagnostic_blob: 'large machine-only audit text that should stay in details',
              },
            ],
            answer_synthesis: {
              analyst_backend: 'local',
              private_context_used: true,
              secure_local_items_consulted: 1,
              internal_items_consulted: 1,
              raw_source_exposed: false,
            },
            latency_ms: 14500,
            phase_timings: {
              lane_setup_ms: 10,
              bulk_gate_ms: 20,
              evidence_pack_ms: 2100,
              analyst_ms: 12100,
              release_gate_ms: 100,
              total_ms: 14500,
            },
            raw_source_exposed: false,
          },
          policy: {
            raw_source_exposed: false,
            source_packets_exposed: false,
            internal_content_exposed: true,
            secure_local_content_exposed: true,
            castor_safe_bridge: true,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const tools = new Map<string, NativeTool>();
    plugin.register({
      pluginConfig: {
        email: {
          enabled: true,
          baseUrl: 'http://source-worker.test',
        },
      },
      registerTool(tool: NativeTool) {
        const materialized = materializeTool(tool);
        tools.set(materialized.name, materialized);
      },
    });

    const result = await tools.get('source_answer')?.execute('tool-call-1', {
      question: 'What do my latest labs and Telegram biomarker messages say?',
      corpus_ids: ['secure_local.dropbox.files', 'internal.telegram.messages'],
      include_secure_local: true,
    }) as { content: Array<{ text: string }>; details: Record<string, unknown> } | undefined;

    expect(calls[0]?.url).toBe('http://source-worker.test/v1/source/answer');
    expect(JSON.parse(calls[0]?.body ?? '{}').corpus_ids).toEqual([
      'secure_local.dropbox.files',
      'internal.telegram.messages',
    ]);
    expect(result?.content[0]?.text).toContain('Answer:\nLDL is elevated');
    expect(result?.content[0]?.text).toContain('1. Recent Labs [secure_local.dropbox.files]');
    expect(result?.content[0]?.text).toContain('Timing: 14500ms total, 2100ms retrieval, 12100ms analyst');
    expect(result?.content[0]?.text).toContain('Policy: raw_source_exposed=false, source_packets_exposed=false, castor_safe_bridge=true');
    expect(result?.content[0]?.text).not.toContain('large machine-only audit text');
    expect(result?.details).toMatchObject({
      audit: {
        lane_audits: [
          {
            diagnostic_blob: 'large machine-only audit text that should stay in details',
          },
        ],
      },
    });
  });

  test('keeps compatibility with flat v0.1 config keys', async () => {
    globalThis.fetch = (async (url) => {
      expect(String(url)).toBe('http://legacy-local.test/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'legacy-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const tools = new Map<string, NativeTool>();
    plugin.register({
      pluginConfig: {
        argus_default_lane: 'fast',
        argus_fast_base_url: 'http://legacy-local.test/v1',
      },
      registerTool(tool: NativeTool) {
        const materialized = materializeTool(tool);
        tools.set(materialized.name, materialized);
      },
    });

    const result = await tools.get('argus_list_models')?.execute('tool-call-1', {});

    expect(result).toMatchObject({
      details: {
        profile: 'default_chat',
        models: [{ id: 'legacy-model' }],
      },
    });
  });
});
